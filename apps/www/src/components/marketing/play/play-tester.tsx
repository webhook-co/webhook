"use client";

import { Button, cn } from "@webhook-co/ui";
import { useCallback, useEffect, useRef, useState } from "react";

// The client for the /play sandbox. It mints an ephemeral capture URL from the play worker
// (play.wbhk.my), shows the URL + a curl command, and streams captured requests over SSE — rendering
// every captured field as an INERT React text node (never HTML), which is the render half of the XSS
// control (the worker's SSE framing is the transport half). No account, no persistence: the worker
// hard-deletes everything on an absolute timer.

// The play worker origin. Overridable at build for local end-to-end testing against `wrangler dev`.
const PLAY_ORIGIN = process.env.NEXT_PUBLIC_PLAY_ORIGIN ?? "https://play.wbhk.my";

export interface Capture {
  id: string;
  method: string;
  headers: Array<[string, string]>;
  contentType: string | null;
  body: string;
  bodyBytes: number;
  truncated: boolean;
  receivedAt: number;
}

interface Session {
  token: string;
  ingestUrl: string;
  expiresAt: number;
  curl: string;
}

type Status = "idle" | "minting" | "live" | "error" | "expired";

export function PlayTester() {
  const [status, setStatus] = useState<Status>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const esRef = useRef<EventSource | null>(null);

  const teardown = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  // Countdown to expiry; when it hits zero, mark expired and STOP the interval (else it fires forever).
  useEffect(() => {
    if (!session) return;
    // Self-clearing interval: the callback closes over `t`, which is assigned before the callback
    // ever fires, so it can clear its own timer once the sandbox expires.
    const t = setInterval(() => {
      const left = Math.max(0, session.expiresAt - Date.now());
      setRemaining(left);
      if (left === 0) {
        setStatus("expired");
        teardown();
        clearInterval(t);
      }
    }, 1000);
    // Paint the countdown immediately rather than waiting a full second for the first tick.
    setRemaining(Math.max(0, session.expiresAt - Date.now()));
    return () => clearInterval(t);
  }, [session, teardown]);

  const start = useCallback(async () => {
    teardown(); // close any prior stream before starting a new one
    setStatus("minting");
    setError(null);
    setCaptures([]);
    try {
      // credentials:include so the browser stores the HttpOnly viewer cookie the mint sets.
      const res = await fetch(`${PLAY_ORIGIN}/api/mint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      });
      if (!res.ok)
        throw new Error(
          res.status === 429
            ? "Too many sandboxes right now — try again in a bit."
            : `mint failed (${res.status})`,
        );
      const s = (await res.json()) as Session;
      setSession(s);
      setStatus("live");

      // No secret in the URL — the HttpOnly cookie authenticates the stream (withCredentials).
      const es = new EventSource(`${PLAY_ORIGIN}/${s.token}/stream`, { withCredentials: true });
      esRef.current = es;
      let opened = false;
      es.onopen = () => {
        opened = true;
      };
      es.onmessage = (evt) => {
        try {
          const record = JSON.parse(evt.data) as Capture;
          setCaptures((prev) => [record, ...prev].slice(0, 100));
        } catch {
          /* keepalive / non-JSON comment */
        }
      };
      es.onerror = () => {
        // Once connected, EventSource auto-reconnects on a transient drop — leave it. But if it never
        // opened (e.g. third-party cookies blocked → the stream 403s), surface a clear error.
        if (esRef.current === es && !opened && es.readyState === EventSource.CLOSED) {
          setError(
            "Couldn't open the live stream — check that third-party cookies aren't blocked.",
          );
          setStatus("error");
        }
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setStatus("error");
    }
  }, [teardown]);

  return (
    <div className="mx-auto max-w-[62ch]">
      {status === "idle" || status === "error" ? (
        <div className="rounded-card border border-hairline bg-surface p-6 text-center">
          <p className="mb-5 text-md text-pretty text-fg-secondary">
            Generate a throwaway URL, send it a request, and watch it land here — no account,
            nothing saved. The sandbox auto-deletes in 15 minutes.
          </p>
          <Button size="md" onClick={start}>
            Create a test URL
          </Button>
          {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
        </div>
      ) : null}

      {status === "minting" ? (
        <p className="text-center text-md text-fg-secondary">Creating your sandbox…</p>
      ) : null}

      {session && (status === "live" || status === "expired") ? (
        <div className="flex flex-col gap-5">
          <div className="rounded-card border border-hairline bg-surface p-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="font-mono text-xs tracking-tight text-fg-muted">
                your sandbox url
              </span>
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  status === "expired" ? "text-danger" : "text-fg-muted",
                )}
              >
                {status === "expired"
                  ? "expired"
                  : `expires in ${Math.floor(remaining / 60000)}:${String(
                      Math.floor((remaining % 60000) / 1000),
                    ).padStart(2, "0")}`}
              </span>
            </div>
            {/* The URL and curl are our own strings (worker-issued) — safe. */}
            <code className="block overflow-x-auto rounded-control bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-fg">
              {session.ingestUrl}
            </code>
            <p className="mt-3 mb-1 font-mono text-xs text-fg-muted">try it:</p>
            <code className="block overflow-x-auto rounded-control bg-surface-sunken px-3 py-2 font-mono text-xs whitespace-pre text-fg-secondary">
              {session.curl}
            </code>
            {status === "expired" ? (
              <div className="mt-4 text-center">
                <Button size="sm" variant="secondary" onClick={start}>
                  Start a new one
                </Button>
              </div>
            ) : null}
          </div>

          <div>
            <p className="mb-2 font-mono text-xs text-fg-muted">
              {captures.length === 0
                ? "waiting for your first request…"
                : `${captures.length} request${captures.length === 1 ? "" : "s"} captured`}
            </p>
            <ul className="flex flex-col gap-3">
              {captures.map((c) => (
                <CaptureRow key={c.id} capture={c} />
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Renders a single captured request. EVERY attacker-controlled field (method, header names/values,
// body) is a React text child — React escapes it, so a `<script>` or `<img onerror>` in the payload
// is shown as literal text and NEVER executed or parsed as HTML. This is the render half of the XSS
// control (play-tester.test.tsx asserts an XSS payload renders as inert text, no injected element).
export function CaptureRow({ capture }: { capture: Capture }) {
  return (
    <li className="overflow-hidden rounded-card border border-hairline bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-2 font-mono text-xs">
        <span className="rounded-control bg-surface-sunken px-1.5 py-0.5 font-semibold text-fg">
          {capture.method}
        </span>
        <span className="text-fg-muted">{capture.contentType ?? "no content-type"}</span>
        <span className="text-fg-faint">{capture.bodyBytes} bytes</span>
      </div>
      <div className="px-4 py-3">
        {capture.headers.length > 0 ? (
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
            {capture.headers.slice(0, 12).map(([name, value], i) => (
              <div key={`${name}-${i}`} className="contents">
                <dt className="text-fg-muted">{name}</dt>
                <dd className="truncate text-fg-secondary">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {capture.body ? (
          <pre className="overflow-x-auto rounded-control bg-surface-sunken px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg-secondary">
            {capture.body}
            {capture.truncated ? "\n…(truncated)" : ""}
          </pre>
        ) : (
          <p className="font-mono text-xs text-fg-faint">empty body</p>
        )}
      </div>
    </li>
  );
}
