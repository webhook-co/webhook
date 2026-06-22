import { buildCommand } from "@stricli/core";
import {
  encodeClientFrame,
  LISTEN_LAG_CAP,
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
import { resolveStateDir } from "../config/paths.js";
import { credentialAccessToken } from "../config/schema.js";
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
import { clearCursor, loadCursor, saveCursor, type CursorLoad } from "../state/cursor-store.js";
import { colorize } from "../output/color.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
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

/** A status-frame backlog at/above this warns the user a replay is coming (the "side-effect cannon"
 *  heads-up, esp. with --forward). Tunable, and intentionally well below the server LISTEN_LAG_CAP. */
const BACKLOG_GUARD = 1_000;

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

/**
 * Resolve where a `listen` run starts, folding in cross-run resume. `--reset` first forgets any saved
 * cursor. With resume on (`--resume` or `--since from-last-ack`), load the persisted OPAQUE cursor and
 * resume from it (`?sinceCursor=`); a miss or a corrupt file cold-starts from "now" (warning on corrupt)
 * so a damaged state file never wedges the tail. Otherwise the existing now|beginning|<cursor> mapping.
 * fs is injected (loadCursor/clearCursor bound to the state dir) so this is unit-tested without disk.
 */
export async function resolveResumeStart(opts: {
  readonly resume: boolean;
  readonly reset: boolean;
  readonly since: string;
  readonly loadCursor: () => Promise<CursorLoad>;
  readonly clearCursor: () => Promise<void>;
  readonly note: (line: string) => void;
}): Promise<ListenSince> {
  if (opts.reset) await opts.clearCursor();
  if (opts.resume || opts.since === "from-last-ack") {
    const loaded = await opts.loadCursor();
    if (loaded.kind === "hit") return { kind: "cursor", cursor: loaded.cursor };
    if (loaded.kind === "corrupt") {
      opts.note(`saved resume cursor unusable (${loaded.detail}) — starting from now\n`);
    }
    return { kind: "now" }; // miss or corrupt → cold-start
  }
  if (opts.since === "beginning") return { kind: "beginning" };
  if (opts.since === "now") return { kind: "now" };
  return { kind: "cursor", cursor: opts.since };
}

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
  /** When set, persist each acked cursor for cross-run resume (the command serializes the writes). */
  readonly persist?: (cursor: string) => void;
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
  let caughtUpNoted = false; // print the "caught up" note once per behind→caught-up transition

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
        // Persist ONLY a newly-forwarded event (inside the !seen guard) — new events arrive in order, so
        // the saved cursor advances monotonically; a redelivery re-acks (below) but must NOT re-persist
        // an older cursor (that would move the resume point backwards → cross-run duplicates).
        deps.persist?.(cursor);
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
            // status frame (ADR-0017): the cursor-contract caughtUp/lag. Caught-up → a one-time note;
            // a backlog at/above the guard → a heads-up that a replay is coming (the "side-effect
            // cannon", esp. with --forward). The count is server-capped at LISTEN_LAG_CAP, so an
            // over-cap value renders as `<cap>+`. All to stderr; stdout stays the event stream.
            if (frame.type === "status") {
              if (frame.caughtUp) {
                if (!caughtUpNoted) {
                  deps.note("caught up — now tailing live events\n");
                  caughtUpNoted = true;
                }
              } else if (frame.lag !== undefined && frame.lag.backlogCount >= BACKLOG_GUARD) {
                caughtUpNoted = false; // fell behind again — re-arm the caught-up note
                const n =
                  frame.lag.backlogCount > LISTEN_LAG_CAP
                    ? `${LISTEN_LAG_CAP}+`
                    : `${frame.lag.backlogCount}`;
                deps.note(`${n} events behind — replaying the backlog…\n`);
              }
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
              // Persist ONLY a newly-seen event (inside the guard) so the resume cursor advances
              // monotonically; a redelivery re-acks (below) but must NOT re-persist an older cursor.
              deps.persist?.(frame.cursor);
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
  resume: boolean;
  reset: boolean;
}

export const listenCommand = buildCommand<ListenFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) return new NotLoggedInError();

    const tunnelUrl = resolveTunnelUrl({
      flag: flags.tunnelUrl,
      env: this.process.env?.[ENV_TUNNEL_URL_VAR],
    });

    // Where the FIRST connect starts, folding in cross-run resume. The persisted cursor is keyed by
    // (profile, endpoint) in the XDG state dir; resume loads it, --reset forgets it.
    const stateDir = resolveStateDir(this.process.env ?? {}, this.homedir);
    const resume = flags.resume || flags.since === "from-last-ack";
    const since = await resolveResumeStart({
      resume: flags.resume,
      reset: flags.reset,
      since: flags.since,
      loadCursor: () => loadCursor(stateDir, profile, endpointId),
      clearCursor: () => clearCursor(stateDir, profile, endpointId),
      note: (line) => this.process.stderr.write(line),
    });

    // With resume on, persist each acked cursor for the next run — serialized so the LAST write wins
    // (out-of-order fire-and-forget writes could otherwise persist an older cursor). A write failure is
    // a noted stderr warning, never fatal: the next ack re-persists, and a missed write just resumes a
    // little earlier. Drained after the loop so the final position is durable on a clean Ctrl-C.
    let persistChain: Promise<void> = Promise.resolve();
    const persist = (cursor: string): void => {
      persistChain = persistChain
        .then(() => saveCursor(stateDir, profile, endpointId, cursor))
        .catch((err) =>
          this.process.stderr.write(`could not save resume cursor: ${errMsg(err)}\n`),
        );
    };

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
        apiKey: credentialAccessToken(cred),
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
        apiKey: credentialAccessToken(cred),
        endpointId,
        since,
        forward,
        persist: resume ? persist : undefined,
        emit: (line) => this.process.stdout.write(line),
        note: (line) => this.process.stderr.write(line),
        format,
        color,
        signal: controller.signal,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
    } finally {
      await persistChain; // flush the final acked cursor to disk before exiting
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
        brief: "now (default) | beginning | from-last-ack | <cursor>",
        default: "now",
      },
      resume: {
        kind: "boolean",
        brief: "resume from the last cursor this (profile, endpoint) acked, and keep saving it",
        default: false,
      },
      reset: {
        kind: "boolean",
        brief: "forget the saved resume cursor for this (profile, endpoint) before starting",
        default: false,
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
