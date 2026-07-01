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
  ENV_DASHBOARD_URL_VAR,
  ENV_TUNNEL_URL_VAR,
  resolveApiBaseUrl,
  resolveDashboardUrl,
  resolveTunnelUrl,
} from "../api-client.js";
import { resolveStateDir } from "../config/paths.js";
import type { AppContext, ConnectWebSocket, WsSocket } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import {
  forwardToLocalhost,
  isDelivered,
  parseForwardTarget,
  type ForwardInput,
  type ForwardOutcome,
} from "../forward.js";
import { bindAuth } from "../oauth/auth-binding.js";
import { abortableSleep, backoffMs } from "../retry.js";
import { createTui, type TuiController, type TuiTerminal } from "../tui/run.js";
import { clearCursor, loadCursor, saveCursor, type CursorLoad } from "../state/cursor-store.js";
import { acquireListenLock, ListenLockedError, type ListenLock } from "../state/listen-lock.js";
import { colorize } from "../output/color.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { CAPABILITY_EXIT, EXIT } from "../output/exit-codes.js";
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

/** Max forward attempts per event before giving up. A target that PERMANENTLY rejects (always-500,
 *  refused) must NOT retry forever: the forward chain is serial + cursor-gated, so an endless retry would
 *  block every later event, never advance the durable cursor, and wedge the whole tail until Ctrl-C. After
 *  this many attempts we stop the tail with a loud, named error (the event stays un-acked → `--resume`
 *  retries it once the target is fixed). High enough to ride out a transient blip via the capped backoff. */
export const FORWARD_MAX_ATTEMPTS = 8;

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
  /** Fires once per newly-seen event (in arrival order, deduped across at-least-once redelivery) — the
   *  interactive TUI consumes this to populate its list. Additive + optional; the plain-tail path omits it. */
  readonly observe?: (summary: EventSummary) => void;
  readonly emit: (line: string) => void;
  readonly note: (line: string) => void;
  readonly format: OutputFormat;
  readonly color: boolean;
  /** Abort to stop the loop (SIGINT in prod; a test-controlled signal under test). */
  readonly signal: AbortSignal;
  /** Backoff sleep (real setTimeout in prod; instant under test). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Stop the tail on an UNRECOVERABLE condition (a --forward target that permanently rejects, or a
   *  backlog larger than --max-backlog). The command maps the reason to a distinct non-zero exit + aborts
   *  the controller; under test it aborts the signal. NOT a user Ctrl-C (that's the signal). */
  readonly stop: (reason: ListenStopReason) => void;
  /** Opt-in flood-refusal: if a status frame reports a backlog ≥ this, stop the tail instead of replaying
   *  it (the `--max-backlog` cap). Undefined = no cap (just the informational banner). */
  readonly maxBacklog?: number;
}

/** Why runListen stopped ITSELF (vs a user Ctrl-C). The command maps each to a distinct exit code. */
export type ListenStopReason = "forward-permanent-failure" | "backlog-exceeded";

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
        { headers: readonly (readonly [string, string])[]; body: Uint8Array } | undefined;
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
      // Bounded: a permanently-failing target must not retry forever (it would block every later event on
      // the serial chain, never advance the durable cursor, and wedge the tail). Give up loudly — naming
      // the stuck event + the attempt count — and stop the tail. The event is left UN-ACKED, so a
      // `--resume` re-run retries it from here once the target is fixed.
      if (n >= FORWARD_MAX_ATTEMPTS) {
        deps.note(
          `giving up on ${summary.id} → ${fwd.targetUrl} after ${n} attempts — stopping the tail (fix the target, then re-run with --resume to retry from here)\n`,
        );
        deps.stop("forward-permanent-failure");
        return false;
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
        deps.observe?.(summary); // feed the TUI (deduped: inside the !seen guard)
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
              } else if (frame.lag !== undefined) {
                const count = frame.lag.backlogCount;
                const n = count > LISTEN_LAG_CAP ? `${LISTEN_LAG_CAP}+` : `${count}`;
                // Opt-in flood-refusal: a backlog at/above --max-backlog stops the tail instead of
                // replaying it (esp. important with --forward — don't fire a huge backlog at localhost).
                // Best-effort: it fires on the first status frame that exceeds the cap, so a few events
                // may arrive before it; raise --max-backlog or use --since now to skip the backlog.
                if (deps.maxBacklog !== undefined && count >= deps.maxBacklog) {
                  deps.note(
                    `refusing to replay: ${n} events behind exceeds --max-backlog ${deps.maxBacklog} — stopping (raise --max-backlog, or use --since now to skip the backlog)\n`,
                  );
                  deps.stop("backlog-exceeded");
                  return;
                }
                if (count >= BACKLOG_GUARD) {
                  caughtUpNoted = false; // fell behind again — re-arm the caught-up note
                  deps.note(`${n} events behind — replaying the backlog…\n`);
                }
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
              deps.observe?.(frame.summary); // feed the TUI (deduped: inside the !seen guard)
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

/** Parse `--max-backlog` to a non-negative integer (0 = refuse ANY backlog). Throws on a bad value so
 *  stricli surfaces it as a usage error. */
function parseMaxBacklog(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--max-backlog must be a non-negative integer (got \`${value}\`)`);
  }
  return n;
}

interface ListenFlags extends GlobalFlags {
  tunnelUrl?: string;
  since: string;
  forward?: string;
  resume: boolean;
  reset: boolean;
  maxBacklog?: number;
}

export const listenCommand = buildCommand<ListenFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) return new NotLoggedInError();
    // Resolve the bearer once (proactively refreshing an OAuth credential at/near expiry) — used for both
    // the tunnel UPGRADE and the --forward api client. The reactive 401 refresh hook is wired into the
    // forward client (HTTP); mid-session refresh over the long-lived tunnel is out of scope here (a fresh
    // connect re-runs this resolution, so an expired-since-last-run token is still refreshed up front).
    const { bearer, refreshAuth } = await bindAuth({
      cred,
      profile,
      store: this.store,
      fetch: this.io.fetch,
      env: this.process.env,
    });

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
    // runListen stops ITSELF on an unrecoverable condition (a permanently-failing --forward target, or a
    // backlog over --max-backlog). Record WHY so we exit with a distinct, scriptable code — never confused
    // with a clean Ctrl-C (exit 0).
    let stopReason: ListenStopReason | undefined;
    const stopWith = (reason: ListenStopReason): void => {
      stopReason = reason;
      controller.abort();
    };
    const applyStopExit = (): void => {
      if (stopReason === "forward-permanent-failure")
        this.process.exitCode = CAPABILITY_EXIT.TARGET_UNREACHABLE;
      else if (stopReason === "backlog-exceeded") this.process.exitCode = EXIT.BACKLOG_EXCEEDED;
    };
    const maxBacklog = flags.maxBacklog;

    // --forward: re-deliver an event to a local server (cursor-gated at-least-once). The plain tail
    // auto-forwards every event (`forward`); the TUI instead arms the `r` key to re-deliver the SELECTED
    // event on demand (`replaySelected`). Both share one api client + validated loopback target.
    let forward: ListenForwardDeps | undefined;
    let replaySelected:
      ((e: EventSummary) => Promise<{ ok: boolean; message: string }>) | undefined;
    if (flags.forward !== undefined) {
      parseForwardTarget(flags.forward); // throws InvalidForwardUrlError (usage) on a non-loopback target
      const apiBaseUrl = resolveApiBaseUrl({
        flag: flags.apiUrl,
        env: this.process.env?.[ENV_API_URL_VAR],
        stored: await this.store.getApiBaseUrl(profile),
      });
      const client = createApiClient({
        baseUrl: apiBaseUrl,
        apiKey: bearer,
        fetch: this.io.fetch,
        refreshAuth,
      });
      const targetUrl = flags.forward;
      const forwardSessionId = crypto.randomUUID(); // a logical id for this forward run's records
      const fetchPayload = async (
        eventId: string,
      ): Promise<{ headers: readonly (readonly [string, string])[]; body: Uint8Array }> => {
        const event = await client.eventsGet(eventId);
        const { body } = await client.eventsGetPayload(eventId);
        return { headers: event.headers, body };
      };
      const post = (input: ForwardInput): Promise<ForwardOutcome> =>
        forwardToLocalhost(
          { fetch: this.io.fetch, now: () => Date.now(), signal: controller.signal },
          input,
        );
      const record = async (eventId: string, idempotencyKey: string): Promise<void> => {
        await client.eventsReplay({
          eventId,
          target: { kind: "localhost-tunnel", sessionId: forwardSessionId },
          idempotencyKey,
        });
      };
      // The auto-forward chain keys idempotency on the cursor → a redelivery records exactly once.
      forward = { targetUrl, fetchPayload, post, record };
      // The TUI's `r`: a deliberate manual re-delivery of the selected event — a fresh idempotency key
      // (like `wbhk replay`) so it's recorded as a distinct attempt rather than deduped against the tail.
      replaySelected = async (e) => {
        try {
          const { headers, body } = await fetchPayload(e.id);
          const outcome = await post({ targetUrl, headers, body });
          if (!outcome.ok)
            return { ok: false, message: `could not reach ${targetUrl}: ${outcome.reason}` };
          if (!isDelivered(outcome))
            return { ok: false, message: `${targetUrl} returned ${outcome.status} (not recorded)` };
          await record(e.id, crypto.randomUUID());
          return {
            ok: true,
            message: `delivered ${e.id} → ${targetUrl} · ${outcome.status} · ${outcome.latencyMs}ms`,
          };
        } catch (err) {
          return { ok: false, message: `replay failed: ${errMsg(err)}` };
        }
      };
    }

    const { format, color } = resolveGlobals(this, flags);

    // Single-listener courtesy lock (resume only) — acquired AFTER all throwing setup (--forward
    // validation, resolveGlobals) so a setup error never leaks a held lock; released in each branch's
    // finally (the TUI's createTui is inside its try, so even a startup throw releases it). Two concurrent
    // resuming listeners would otherwise race the cursor file (last-finisher wins → a re-delivery window).
    // A live holder → ListenLockedError (CliError → exit LISTENER_BUSY); a crashed run's stale lock
    // self-heals (reclaimed once its holder pid is seen dead).
    let lock: ListenLock | undefined;
    if (resume) {
      try {
        lock = await acquireListenLock(stateDir, profile, endpointId);
      } catch (err) {
        if (err instanceof ListenLockedError) return err;
        throw err;
      }
    }

    // Interactive TTY → the in-tail TUI (an interactive replay browser: arrow/j/k to navigate, d for
    // detail, o to open in the dashboard, r to replay the selected event to --forward, q/Ctrl-C to quit).
    // Off a TTY (piped / non-interactive) fall through to the plain line tail. The TUI runs the loop in
    // INSPECTION mode even with --forward (it does NOT auto-fire the whole stream at localhost); --forward
    // only arms the on-demand `r` replay above.
    if (this.io.isTTY) {
      // Raw mode delivers Ctrl-C as a key (the TUI maps it to quit); keep SIGTERM as a safety stop.
      const onSignalTui = (): void => controller.abort();
      process.once("SIGTERM", onSignalTui);
      // createTui (enters raw mode / alt-screen) lives INSIDE the try so even a startup throw releases the
      // lock + runs the terminal restore via the finally. tuiRef is captured for the finally.
      let tuiRef: TuiController | undefined;
      try {
        const dashboardBase = resolveDashboardUrl({
          env: this.process.env?.[ENV_DASHBOARD_URL_VAR],
        });
        const terminal: TuiTerminal = {
          write: (s) => this.process.stdout.write(s),
          size: () => this.io.terminalSize(),
          start: (h) => this.io.startRawInput(h),
        };
        const tui = createTui({
          terminal,
          color,
          effects: {
            // encodeURIComponent the server-controlled id (defense-in-depth: it can't break out of the
            // dashboard path even if a future id format isn't a bare uuid).
            dashboardUrl: (e) => `${dashboardBase}/events/${encodeURIComponent(e.id)}`,
            openBrowser: (url) => this.io.openBrowser(url),
            replay: replaySelected,
          },
        });
        tuiRef = tui;
        const loop = runListen({
          connect: this.io.connectWebSocket,
          tunnelUrl,
          apiKey: bearer,
          endpointId,
          since,
          persist: resume ? persist : undefined,
          observe: (s) => tui.pushEvent(s),
          emit: () => {}, // the TUI list IS the event display (fed via observe) — drop the per-line emit
          note: (line) => tui.note(line.replace(/\s+$/, "")), // notices/backlog guard → the status line
          format,
          color,
          signal: controller.signal,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          stop: stopWith, // forward is off in the TUI; only --max-backlog can trigger this here
          maxBacklog,
        });
        // If the loop ends on its own (error/abort), close the TUI. `.catch` swallows the rejection on
        // THIS branch only — the real error still rides `await loop` below (so it surfaces once, not as an
        // unhandled rejection).
        loop.finally(() => tui.stop()).catch(() => {});
        await tui.finished; // the user quit (q / Ctrl-C inside the TUI)
        controller.abort(); // stop the tunnel loop
        await loop; // drain
      } finally {
        tuiRef?.stop(); // restore the screen even if the loop (or createTui) threw
        await persistChain;
        await lock?.release();
        process.removeListener("SIGTERM", onSignalTui);
      }
      applyStopExit(); // exit BACKLOG_EXCEEDED if --max-backlog refused a too-large backlog
      return;
    }

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
        apiKey: bearer,
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
        stop: stopWith,
        maxBacklog,
      });
    } finally {
      await persistChain; // flush the final acked cursor to disk before exiting
      await lock?.release();
      process.stdout.removeListener("error", onStdoutError);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    // Distinct non-zero exit when runListen stopped itself (forward permanent-failure → TARGET_UNREACHABLE,
    // backlog over --max-backlog → BACKLOG_EXCEEDED); a clean Ctrl-C leaves exit 0.
    applyStopExit();
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
      maxBacklog: {
        kind: "parsed",
        parse: parseMaxBacklog,
        brief:
          "refuse to replay if more than N events are behind (avoids firing a big backlog at --forward)",
        optional: true,
      },
    },
  },
  docs: {
    brief: "stream an endpoint's events live, or --forward them to localhost (Ctrl+C to stop)",
  },
});
