import { buildCommand } from "@stricli/core";
import {
  encodeClientFrame,
  parseServerFrame,
  type EventSummary,
  type ServerFrame,
} from "@webhook-co/shared";

import {
  createApiClient,
  ENV_API_URL_VAR,
  ENV_TUNNEL_URL_VAR,
  resolveApiBaseUrl,
  resolveTunnelUrl,
} from "../api-client.js";
import type { AppContext, ConnectWebSocket, WsSocket } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import {
  forwardToLocalhost,
  isDelivered,
  parseForwardTarget,
  type ForwardInput,
  type ForwardOutcome,
} from "../forward.js";
import { abortableSleep, backoffMs } from "../retry.js";
import { colorize } from "../output/color.js";
import { globalFlags, resolveGlobals, resolveProfile, type GlobalFlags } from "../global-flags.js";
import { type OutputFormat } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";

// `wbhk listen <endpointId>` — the live tail. Opens the bearer-authed `/listen` WebSocket tunnel
// (ADR-0014), prints each captured event as it arrives, and acks it so the durable cursor advances
// (at-least-once; the client dedups). Reconnects with capped backoff across drops, reusing the
// session id so the engine resumes from the durable cursor. With `--forward <localhost-url>` it
// re-delivers each event to a local server instead of printing — cursor-gated at-least-once (ack +
// record the delivery only after a local 2xx; reuses the forwarder + events.replay from ADR-0016).
//
// `--since` (the engine resumes from an OPAQUE, engine-signed cursor; the CLI can't construct a time
// cursor, so "now" is a server-side hint):
//   now (default) — only NEW events: the `?since=now` sentinel starts a new session from the current
//                   position, computed server-side (a cli-only seed can't — events.tail returns no
//                   cursor when caught up; see the ADR-0014 follow-up in memory).
//   beginning     — replay the full retained backlog, then tail (connect with no cursor).
//   <cursor>      — resume from an explicit opaque cursor (e.g. a prior nextCursor).

/** Bounds the dedup memory of a long session; far above the at-least-once redelivery window. */
const SEEN_CURSOR_CAP = 50_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One compact tail line per event (text mode). Human-facing format — eyeball before release. */
export function formatListenEvent(summary: EventSummary, color: boolean): string {
  const when = summary.receivedAt.toISOString();
  // provider + id are server-controlled — sanitize so a hostile value can't inject a terminal escape.
  const provider = summary.provider === null ? "—" : sanitizeControl(summary.provider);
  const verified = summary.verified
    ? colorize("verified", "green", color)
    : colorize("unverified", "yellow", color);
  return `${when}  ${provider}  ${verified}  ${sanitizeControl(summary.id)}`;
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

/** Forward mode (`--forward`): re-deliver each tailed event to a local server, cursor-gated. */
export interface ListenForwardDeps {
  readonly targetUrl: string;
  /** Fetch the event's captured headers + exact body (events.get + events.getPayload). */
  readonly fetchPayload: (
    eventId: string,
  ) => Promise<{ headers: readonly (readonly [string, string])[]; body: Uint8Array }>;
  /** POST to the loopback target (forwardToLocalhost bound with the io fetch + clock). */
  readonly post: (input: ForwardInput) => Promise<ForwardOutcome>;
  /** Record the forward server-side (events.replay), keyed by the event cursor (idempotent). */
  readonly record: (eventId: string, cursor: string) => Promise<void>;
}

export interface RunListenDeps {
  readonly connect: ConnectWebSocket;
  readonly tunnelUrl: string;
  readonly apiKey: string;
  readonly endpointId: string;
  /** Where to start on the FIRST connect (--since). Reconnects always resume from the durable cursor. */
  readonly since: ListenSince;
  /** When set, forward each event to a local server (cursor-gated) instead of just printing it. */
  readonly forward?: ListenForwardDeps;
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

  // Forward mode: a SERIAL chain preserves event order + cursor-gating (ack only after a local 2xx).
  // Each event captures its arrival socket; if that socket closes before the forward finishes, the
  // best-effort ack is a no-op and the un-acked event redelivers on reconnect — the (now-seen)
  // redelivery re-acks via the live socket. A link never rejects (errors are noted), so the chain
  // can't break.
  let forwardChain: Promise<void> = Promise.resolve();

  const forwardWithRetry = async (summary: EventSummary): Promise<boolean> => {
    const fwd = deps.forward;
    if (!fwd) return false;
    for (let n = 1; !deps.signal.aborted; n += 1) {
      let payload:
        | { headers: readonly (readonly [string, string])[]; body: Uint8Array }
        | undefined;
      try {
        payload = await fwd.fetchPayload(summary.id);
      } catch (err) {
        deps.note(`fetching ${summary.id} failed: ${errMsg(err)} — retrying\n`);
      }
      if (payload) {
        const outcome = await fwd.post({
          targetUrl: fwd.targetUrl,
          headers: payload.headers,
          body: payload.body,
        });
        if (outcome.ok && isDelivered(outcome)) {
          deps.emit(
            deps.format === "json"
              ? `${JSON.stringify({ forwarded: summary.id, target: fwd.targetUrl, status: outcome.status, latencyMs: outcome.latencyMs })}\n`
              : `forwarded ${summary.id} → ${fwd.targetUrl} · ${outcome.status} · ${outcome.latencyMs}ms\n`,
          );
          return true;
        }
        deps.note(
          `forward ${summary.id} → ${outcome.ok ? `HTTP ${outcome.status}` : outcome.reason} — retrying\n`,
        );
      }
      await abortableSleep(deps.signal, deps.sleep, backoffMs(n));
    }
    return false;
  };

  const processForward = async (
    summary: EventSummary,
    cursor: string,
    sock: WsSocket,
  ): Promise<void> => {
    try {
      if (deps.signal.aborted) return;
      if (!seen.has(cursor)) {
        if (!(await forwardWithRetry(summary))) return; // aborted before a 2xx → leave un-acked
        try {
          await deps.forward?.record(summary.id, cursor);
        } catch (err) {
          // Recording failed (transient): do NOT ack or mark seen — the un-acked event redelivers and
          // the forward + record retry (at-least-once; the local server dedups by webhook-id).
          deps.note(`recording the forward of ${summary.id} failed: ${errMsg(err)} — will retry\n`);
          return;
        }
        remember(cursor);
      }
      // Best-effort ack (advance the durable cursor); a closed socket no-ops and redelivery re-acks.
      sock.send(encodeClientFrame({ type: "ack", cursor }));
    } catch (err) {
      deps.note(`forward of ${summary.id} errored: ${errMsg(err)}\n`);
    }
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
              // code/message are server-controlled (z.string()) — sanitize before the stderr notice.
              deps.note(
                `tunnel notice [${sanitizeControl(frame.code)}]: ${sanitizeControl(frame.message)}\n`,
              );
              return;
            }
            // status frame (ADR-0017): the cursor-contract caughtUp/lag. Skipped for now — Lane D's D6
            // replaces this with the resume banner + backlog guard. Skipping keeps the tunnel
            // additive-safe (an unhandled server frame is a no-op, never a crash).
            if (frame.type === "status") {
              return;
            }
            // event frame.
            if (deps.forward) {
              // forward mode: serialize forward+ack (cursor-gated). Capture THIS socket for the ack.
              const sock = socket;
              const ev = frame;
              forwardChain = forwardChain.then(() => processForward(ev.summary, ev.cursor, sock));
              return;
            }
            // inspection mode: ack always (advance the durable cursor) but print only once.
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
    await abortableSleep(deps.signal, deps.sleep, backoffMs(attempt));
  }
  // Drain any in-flight / queued forwards before returning (clean shutdown).
  await forwardChain;
}

interface ListenFlags extends GlobalFlags {
  tunnelUrl?: string;
  since: string;
  forward?: string;
}

export const listenCommand = buildCommand<ListenFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const profile = await resolveProfile(this, flags);
    const cred = await this.store.get(profile);
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

    // --forward: re-deliver each event to a local server (cursor-gated at-least-once) instead of just
    // printing. Needs the api client (fetch the captured body + record) + a validated loopback target.
    let forward: ListenForwardDeps | undefined;
    if (flags.forward !== undefined) {
      parseForwardTarget(flags.forward); // throws InvalidForwardUrlError (usage) on a non-loopback target
      const apiBaseUrl = resolveApiBaseUrl({
        flag: flags.apiUrl,
        env: this.process.env?.[ENV_API_URL_VAR],
        stored: await this.store.getApiBaseUrl(profile),
      });
      const client = createApiClient({
        baseUrl: apiBaseUrl,
        apiKey: cred.apiKey,
        fetch: this.io.fetch,
      });
      const targetUrl = flags.forward;
      const forwardSessionId = crypto.randomUUID(); // a logical id for this forward run's records
      forward = {
        targetUrl,
        fetchPayload: async (eventId) => {
          const event = await client.eventsGet(eventId);
          const { body } = await client.eventsGetPayload(eventId);
          return { headers: event.headers, body };
        },
        post: (input) =>
          forwardToLocalhost(
            { fetch: this.io.fetch, now: () => Date.now(), signal: controller.signal },
            input,
          ),
        record: async (eventId, cursor) => {
          // cursor as the idempotency key → a redelivered event records exactly once.
          await client.eventsReplay({
            eventId,
            target: { kind: "localhost-tunnel", sessionId: forwardSessionId },
            idempotencyKey: cursor,
          });
        },
      };
    }

    const { format, color } = resolveGlobals(this, flags);
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
        forward,
        emit: (line) => this.process.stdout.write(line),
        note: (line) => this.process.stderr.write(line),
        format,
        color,
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
      ...globalFlags,
      apiUrl: {
        ...globalFlags.apiUrl,
        brief: "override the API base URL (used by --forward to fetch the body + record)",
      },
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
      forward: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "forward each event to a local URL, e.g. http://localhost:3000/webhooks",
        optional: true,
      },
    },
  },
  docs: {
    brief: "stream an endpoint's events live, or --forward them to localhost (Ctrl+C to stop)",
  },
});
