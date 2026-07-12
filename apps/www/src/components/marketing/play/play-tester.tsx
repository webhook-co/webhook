"use client";

import { Button, cn } from "@webhook-co/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { playSitekey, Turnstile } from "@/components/marketing/play/turnstile";

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
}

type Status = "idle" | "minting" | "live" | "error" | "expired";

/**
 * Where a live sandbox is remembered across a reload. WHY THIS EXISTS: the sandbox outlives the page.
 * The Durable Object runs its full 15-minute TTL and the mint coordinator only prunes by expiry — it
 * has no release path — so a reload used to strand a live sandbox that still counted against the
 * per-IP mint budget (5). Five reloads and you were rate-limited for fifteen minutes by sandboxes you
 * could no longer see. Remembering the session makes the reload free instead of expensive.
 *
 * WHAT IS STORED: the token, its URL, and its expiry — all of which the worker already hands the page
 * in the clear. The viewer SECRET is deliberately NOT here: it stays in the HttpOnly cookie, where
 * page JavaScript cannot read it. sessionStorage (not localStorage) so it dies with the tab.
 */
export const PLAY_SESSION_KEY = "wbhk.play.session";

/**
 * The one and only source of the example command. Derived from the ingest URL rather than sent by the
 * worker, so a freshly-minted sandbox and a restored one can never show different commands.
 */
function curlFor(ingestUrl: string): string {
  return `curl -X POST ${ingestUrl} -H 'content-type: application/json' -d '{"hello":"webhook.co"}'`;
}

export function PlayTester() {
  const [status, setStatus] = useState<Status>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [copied, setCopied] = useState<string | null>(null);
  // The Turnstile token is SINGLE-USE. `challengeNonce` remounts the widget after each mint so the next
  // one gets a fresh token instead of replaying a spent one (which the worker would refuse).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [challengeNonce, setChallengeNonce] = useState(0);
  const sitekey = playSitekey();
  const challengeRequired = sitekey !== "";
  const esRef = useRef<EventSource | null>(null);

  const teardown = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  /**
   * Open the live stream for a session and show it. Used both by a fresh mint and by a reload-restore
   * — the reconnecting stream is authenticated by the HttpOnly cookie (which survives the reload), and
   * the Durable Object replays its capture backlog, so the requests you already sent come back too.
   */
  const attach = useCallback(
    (s: Session) => {
      teardown();
      setSession(s);
      setCaptures([]);
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
    },
    [teardown],
  );

  // Re-attach a sandbox that survived a reload. Anything expired or unparseable is swept rather than
  // shown — handing someone a dead URL is worse than handing them a button.
  useEffect(() => {
    const raw = sessionStorage.getItem(PLAY_SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as Session;
      if (!s?.token || typeof s.expiresAt !== "number" || s.expiresAt <= Date.now()) {
        sessionStorage.removeItem(PLAY_SESSION_KEY);
        return;
      }
      attach(s);
    } catch {
      sessionStorage.removeItem(PLAY_SESSION_KEY);
    }
  }, [attach]);

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
        // The sandbox is gone server-side; don't let a reload resurrect a dead URL.
        sessionStorage.removeItem(PLAY_SESSION_KEY);
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
        // In prod the worker runs TURNSTILE_MODE=on and refuses a mint without a valid token (403).
        body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
        credentials: "include",
      });
      // Spend the token: a fresh challenge for the next mint, whatever happens below.
      setTurnstileToken(null);
      setChallengeNonce((n) => n + 1);
      if (!res.ok)
        throw new Error(
          res.status === 429
            ? "Too many sandboxes right now — try again in a bit."
            : `mint failed (${res.status})`,
        );
      const s = (await res.json()) as Session;
      // Remember it BEFORE attaching, so even an immediate reload finds the sandbox we just paid for.
      // Token/url/expiry only — never the viewer secret, which lives in the HttpOnly cookie.
      sessionStorage.setItem(
        PLAY_SESSION_KEY,
        JSON.stringify({ token: s.token, ingestUrl: s.ingestUrl, expiresAt: s.expiresAt }),
      );
      attach(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setStatus("error");
    }
  }, [teardown, attach, turnstileToken]);

  /**
   * Copy a worker-issued string (our own, never user input) and announce it to assistive tech.
   * The timer is held in a ref and cleared on each copy: without that, copying the url and then the
   * curl 1.9s later lets the FIRST timer fire and wipe the second confirmation after 100ms.
   */
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback(async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // clipboard denied (insecure context / permissions) — the text is selectable either way
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(what);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  }, []);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  return (
    <div className="mx-auto max-w-[62ch]">
      {status === "idle" || status === "error" ? (
        <div className="rounded-card border border-hairline bg-surface p-6 text-center">
          <p className="mb-5 text-md text-pretty text-fg-secondary">
            Generate a throwaway URL, send it a request, and watch it land here — no account,
            nothing saved. The sandbox auto-deletes in 15 minutes.
          </p>

          {/* Minting is unauthenticated and costs a Durable Object, so it sits behind a challenge —
              in prod the worker refuses a mint without a valid token. The button is gated on the
              solved token rather than firing a request we know will be refused. The widget is keyed
              by `challengeNonce`: a token is single-use, so each mint remounts it for a fresh one. */}
          {challengeRequired ? (
            <div className="mb-5">
              <Turnstile key={challengeNonce} onToken={setTurnstileToken} />
            </div>
          ) : null}

          <Button size="md" onClick={start} disabled={challengeRequired && turnstileToken === null}>
            Create a test URL
          </Button>
          {challengeRequired && turnstileToken === null ? (
            <p className="mt-3 text-sm text-fg-muted">Just checking you&rsquo;re human first…</p>
          ) : null}
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
            <div className="flex items-stretch gap-2">
              <code className="block flex-1 overflow-x-auto rounded-control bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-fg">
                {session.ingestUrl}
              </code>
              <CopyButton
                label="Copy sandbox url"
                onCopy={() => copy("url", session.ingestUrl)}
                copied={copied === "url"}
              />
            </div>
            <p className="mt-3 mb-1 font-mono text-xs text-fg-muted">try it:</p>
            <div className="flex items-stretch gap-2">
              <code className="block flex-1 overflow-x-auto rounded-control bg-surface-sunken px-3 py-2 font-mono text-xs whitespace-pre text-fg-secondary">
                {curlFor(session.ingestUrl)}
              </code>
              <CopyButton
                label="Copy curl command"
                onCopy={() => copy("curl", curlFor(session.ingestUrl))}
                copied={copied === "curl"}
              />
            </div>
            <p className="mt-3 text-xs text-fg-muted">
              Any method works — POST, PUT, DELETE, even a plain GET you can paste straight into
              your browser. Same as a real endpoint.
            </p>
            {/* Announced, not just painted. The text must NAME what was copied: a bare "copied" string
                is unchanged when you copy the url and then the curl, and aria-live only announces on
                a CHANGE — so the second copy would be silent for a screen-reader user. */}
            <p role="status" aria-live="polite" className="sr-only">
              {copied === "url"
                ? "sandbox url copied"
                : copied === "curl"
                  ? "curl command copied"
                  : ""}
            </p>
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

/** A real <button> (not a click-handling div) so it's keyboard-reachable and named for assistive tech. */
function CopyButton({
  label,
  onCopy,
  copied,
}: {
  label: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onCopy}
      className="shrink-0 rounded-control border border-hairline bg-surface px-3 font-mono text-xs text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * The colour for an HTTP method badge, from the design system's semantic token triplets
 * (`ok` / `warn` / `danger` / `info`, each a matched text+bg+border set).
 *
 * The mapping is the conventional REST reading of the verb: read (info), create (ok), update (warn),
 * remove (danger). OPTIONS/HEAD are metadata, so they stay neutral rather than borrowing a meaning.
 *
 * TINTED text on a pale background, never a saturated fill: a solid brand-colour chip cannot hold
 * 4.5:1 against its own label at this glyph size — an earlier lane learned that the hard way. Each
 * triplet is designed to pass together, and the axe pass in the tests keeps it honest.
 *
 * Colour is REINFORCEMENT, never the signal (WCAG 1.4.1): the verb is spelled out in the badge, so a
 * reader who can't distinguish the hues loses nothing.
 */
const VERB_STYLES: Record<string, string> = {
  GET: "bg-info-bg text-info border-info-border",
  POST: "bg-ok-bg text-ok border-ok-border",
  PUT: "bg-warn-bg text-warn border-warn-border",
  PATCH: "bg-warn-bg text-warn border-warn-border",
  DELETE: "bg-danger-bg text-danger border-danger-border",
};
/** Anything else (OPTIONS, HEAD, and any verb a caller invents) — neutral, and still legible. */
const VERB_NEUTRAL = "bg-surface-sunken text-fg-secondary border-hairline";

export function verbStyle(method: string): string {
  return VERB_STYLES[method.toUpperCase()] ?? VERB_NEUTRAL;
}

// Renders a single captured request. EVERY attacker-controlled field (method, header names/values,
// body) is a React text child — React escapes it, so a `<script>` or `<img onerror>` in the payload
// is shown as literal text and NEVER executed or parsed as HTML. This is the render half of the XSS
// control (play-tester.test.tsx asserts an XSS payload renders as inert text, no injected element).
export function CaptureRow({ capture }: { capture: Capture }) {
  return (
    <li className="overflow-hidden rounded-card border border-hairline bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-2 font-mono text-xs">
        <span
          className={cn(
            "rounded-control border px-1.5 py-0.5 font-semibold",
            verbStyle(capture.method),
          )}
        >
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
