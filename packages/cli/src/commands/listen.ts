import { buildCommand } from "@stricli/core";
import {
  encodeClientFrame,
  parseServerFrame,
  type EventSummary,
  type ServerFrame,
} from "@webhook-co/shared";

import { ENV_TUNNEL_URL_VAR, resolveTunnelUrl } from "../api-client.js";
import type { AppContext, ConnectWebSocket } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { colorize } from "../output/color.js";
import { resolveFormat, type OutputFormat } from "../output/format.js";

// `wbhk listen <endpointId>` — the live tail. Opens the bearer-authed `/listen` WebSocket tunnel
// (ADR-0014), prints each captured event as it arrives, and acks it so the durable cursor advances
// (at-least-once; the client dedups). Reconnects with capped backoff across drops, reusing the
// session id so the engine resumes from the durable cursor. The forward-to-localhost half is slice
// 12c (PR3); this is inspection only.
//
// `--since` (the engine resumes from an OPAQUE, engine-signed cursor; the CLI can't construct a time
// cursor, so "now" is a server-side hint):
//   now (default) — only NEW events: the `?since=now` sentinel starts a new session from the current
//                   position, computed server-side (a cli-only seed can't — events.tail returns no
//                   cursor when caught up; see the ADR-0014 follow-up in memory).
//   beginning     — replay the full retained backlog, then tail (connect with no cursor).
//   <cursor>      — resume from an explicit opaque cursor (e.g. a prior nextCursor).

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/** Bounds the dedup memory of a long session; far above the at-least-once redelivery window. */
const SEEN_CURSOR_CAP = 50_000;

/** Capped exponential backoff with full jitter (attempt is 1-based). */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const capped = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(capped / 2 + rand() * (capped / 2));
}

/** One compact tail line per event (text mode). Human-facing format — eyeball before release. */
export function formatListenEvent(summary: EventSummary, color: boolean): string {
  const when = summary.receivedAt.toISOString();
  const provider = summary.provider ?? "—";
  const verified = summary.verified
    ? colorize("verified", "green", color)
    : colorize("unverified", "yellow", color);
  return `${when}  ${provider}  ${verified}  ${summary.id}`;
}

/**
 * Where `wbhk listen` starts (resolved from --since). "now" → only new events (the engine `?since=now`
 * sentinel computes the boundary server-side); "beginning" → replay the full backlog (no cursor);
 * "cursor" → resume from an explicit opaque cursor. (A cli-only "now" seed isn't possible: events.tail
 * returns no cursor when caught up, and the CLI can't sign one — see ADR-0014 follow-up in memory.)
 */
export type ListenSince =
  | { readonly kind: "now" }
  | { readonly kind: "beginning" }
  | { readonly kind: "cursor"; readonly cursor: string };

export interface RunListenDeps {
  readonly connect: ConnectWebSocket;
  readonly tunnelUrl: string;
  readonly apiKey: string;
  readonly endpointId: string;
  /** Where to start on the FIRST connect (--since). Reconnects always resume from the durable cursor. */
  readonly since: ListenSince;
  readonly emit: (line: string) => void;
  readonly note: (line: string) => void;
  readonly format: OutputFormat;
  readonly color: boolean;
  /** Abort to stop the loop (SIGINT in prod; a test-controlled signal under test). */
  readonly signal: AbortSignal;
  /** Backoff sleep (real setTimeout in prod; instant under test). */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The reconnect loop: connect → consume server frames (ready saves the session id; event prints +
 * acks + dedups; error is a non-fatal stderr notice) → on close/error, back off and reconnect with
 * the same session id (the engine resumes from the durable cursor). Exits when `signal` aborts.
 * Exported (not the stricli func) so the whole loop is unit-tested with a fake socket — no network,
 * no real timers, no SIGINT.
 */
export async function runListen(deps: RunListenDeps): Promise<void> {
  const seen = new Set<string>(); // dedup by cursor across at-least-once redelivery
  let sessionId: string | undefined;
  let firstConnect = true;
  let attempt = 0;

  const remember = (cursor: string): void => {
    if (seen.size >= SEEN_CURSOR_CAP) seen.delete(seen.values().next().value as string);
    seen.add(cursor);
  };

  while (!deps.signal.aborted) {
    // Each connection resolves to whether the loop should reconnect (a drop) or stop (abort).
    const shouldReconnect = await new Promise<boolean>((resolve) => {
      const qs = new URLSearchParams({ endpointId: deps.endpointId });
      if (sessionId !== undefined) qs.set("sessionId", sessionId);
      // Only the FIRST connect carries --since; reconnects resume from the durable cursor (sessionId).
      if (firstConnect) {
        if (deps.since.kind === "now") qs.set("since", "now");
        else if (deps.since.kind === "cursor") qs.set("sinceCursor", deps.since.cursor);
        // beginning → neither param: the engine flushes the full backlog
      }

      let settled = false;
      let removeAbort = (): void => {};
      const settle = (reconnect: boolean): void => {
        if (!settled) {
          settled = true;
          removeAbort(); // drop this connection's abort listener so reconnects don't accumulate them
          resolve(reconnect);
        }
      };

      const socket = deps.connect(`${deps.tunnelUrl}/listen?${qs.toString()}`, {
        headers: { authorization: `Bearer ${deps.apiKey}` },
        handlers: {
          onOpen: () => {
            attempt = 0; // a successful open resets the backoff
          },
          onMessage: (data: string) => {
            const frame: ServerFrame | null = parseServerFrame(data);
            if (frame === null) return; // skip a garbled frame, stay connected
            if (frame.type === "ready") {
              sessionId = frame.sessionId; // resume target for reconnects
              return;
            }
            if (frame.type === "error") {
              deps.note(`tunnel notice [${frame.code}]: ${frame.message}\n`);
              return;
            }
            // event frame: ack always (advance the durable cursor) but print only once.
            if (!seen.has(frame.cursor)) {
              remember(frame.cursor);
              deps.emit(
                deps.format === "json"
                  ? `${JSON.stringify(frame.summary)}\n` // compact: one event per line (NDJSON)
                  : `${formatListenEvent(frame.summary, deps.color)}\n`,
              );
            }
            socket.send(encodeClientFrame({ type: "ack", cursor: frame.cursor }));
          },
          onClose: () => settle(true),
          onError: (err: Error) => {
            deps.note(`tunnel error: ${err.message}\n`);
            settle(true);
          },
        },
      });

      // On abort (Ctrl+C): close the socket and stop — do not reconnect. The loop guard already
      // excluded a pre-aborted signal, and nothing awaits between that guard and here, so abort can
      // only arrive while this connection is live — the listener handles it; `settle` removes it.
      const onAbort = (): void => {
        socket.close();
        settle(false);
      };
      deps.signal.addEventListener("abort", onAbort);
      removeAbort = () => deps.signal.removeEventListener("abort", onAbort);
    });

    firstConnect = false;
    if (!shouldReconnect || deps.signal.aborted) break;
    attempt += 1;
    // Abortable backoff: wake immediately on Ctrl+C instead of blocking for up to the full backoff.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        deps.signal.removeEventListener("abort", finish);
        resolve();
      };
      deps.signal.addEventListener("abort", finish, { once: true });
      void deps.sleep(backoffMs(attempt)).then(finish);
    });
  }
}

interface ListenFlags {
  output: OutputFormat;
  tunnelUrl?: string;
  since: string;
}

export const listenCommand = buildCommand<ListenFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const cred = await this.store.get();
    if (cred === null) return new NotLoggedInError();

    const tunnelUrl = resolveTunnelUrl({
      flag: flags.tunnelUrl,
      env: this.process.env?.[ENV_TUNNEL_URL_VAR],
    });

    // Map --since to where the FIRST connect starts (the engine computes "now" server-side).
    const since: ListenSince =
      flags.since === "beginning"
        ? { kind: "beginning" }
        : flags.since === "now"
          ? { kind: "now" }
          : { kind: "cursor", cursor: flags.since };

    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    // A closed stdout (e.g. `wbhk listen | head`) raises EPIPE; abort + exit cleanly rather than crash.
    const onStdoutError = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.stdout.on("error", onStdoutError);
    try {
      await runListen({
        connect: this.io.connectWebSocket,
        tunnelUrl,
        apiKey: cred.apiKey,
        endpointId,
        since,
        emit: (line) => this.process.stdout.write(line),
        note: (line) => this.process.stderr.write(line),
        format: resolveFormat(flags.output),
        color: this.colorEnabled,
        signal: controller.signal,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    } finally {
      process.stdout.removeListener("error", onStdoutError);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: {
      output: { kind: "enum", values: ["text", "json"], brief: "output format", default: "text" },
      since: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "now (default) | beginning | <cursor>",
        default: "now",
      },
      tunnelUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the tunnel URL (wss://)",
        optional: true,
      },
    },
  },
  docs: { brief: "stream an endpoint's events live (Ctrl+C to stop)" },
});
