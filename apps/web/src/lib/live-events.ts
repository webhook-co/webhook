import {
  encodeClientFrame,
  type EventSummary,
  LISTEN_SUBPROTOCOL,
  LISTEN_TICKET_SUBPROTOCOL_PREFIX,
  type Lag,
  parseServerFrame,
} from "@webhook-co/shared";

import type { EventSummaryItem } from "@/server/events";

// The browser-side live-events session — a pure, framework-free controller over the engine's `/listen`
// WebSocket (ADR-0014 wire protocol). React-free on purpose: `useLiveEvents` wraps it, and the state
// machine (mint → connect → ready → tail → reconnect) is unit-tested with a FakeWebSocket and injected
// timers, no real network. The socket is READ-ONLY — it only ever sends advisory `ack` frames; it never
// mutates data and never meters (reads don't bill). Dedup is the CONSUMER's job (the hook prepends +
// dedups by id); this core just emits already-mapped items.

/** Structural mirror of the web `mintListenTicketAction` result — the server action is assignable to it. */
export type MintTicketResult =
  | { readonly ok: true; readonly ticket: string; readonly subprotocol: string }
  | { readonly ok: false; readonly error: string };

/** Coarse connection state surfaced to the UI indicator. */
export type LiveConnectionStatus = "connecting" | "connected" | "disconnected";

/** The cursor-contract status projected from a StatusFrame. */
export interface LiveStatus {
  readonly caughtUp: boolean;
  readonly lag?: Lag;
}

/** The minimal WebSocket surface the core drives — the browser `WebSocket` satisfies it structurally. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** Construct signature for a WebSocket (injectable so tests pass a FakeWebSocket). */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface LiveEventsSessionOptions {
  /** The `wss://…/listen` base URL (derived server-side from the ingest apex; never hardcoded here). */
  readonly wsUrl: string;
  readonly endpointId: string;
  /** Mint a fresh listen ticket (the session-authed web action); called before every (re)connect. */
  readonly mintTicket: (endpointId: string) => Promise<MintTicketResult>;
  /** Each arrived, already-mapped event item (the consumer prepends + dedups). */
  readonly onEvent: (item: EventSummaryItem) => void;
  /** The latest cursor-contract status (caught-up + capped backlog lag). */
  readonly onStatus: (status: LiveStatus) => void;
  /** Coarse connection transitions for the UI indicator. */
  readonly onConnectionChange: (status: LiveConnectionStatus) => void;
  /** A user-facing reason the stream couldn't start (e.g. the ticket mint failed). Optional. */
  readonly onError?: (message: string) => void;
  /** Injected so tests use a FakeWebSocket; defaults to the global `WebSocket`. */
  /**
   * An opaque cursor to resume from, for a session that is CONTINUING rather than starting.
   *
   * Absent = a fresh "go live" ⇒ the socket asks for `since=now` and the reader sees only what arrives from
   * that moment on (history is not live). Present = the tail was PAUSED (the tab was hidden, so the hook
   * stopped the session) and is picking up where it left off — those events arrived while Live was ON, so
   * they are not history and must not be dropped.
   */
  readonly seedFrom?: string;
  /** Called with each delivered event's opaque cursor, so a caller can survive a pause and resume from it. */
  readonly onCursor?: (cursor: string) => void;
  readonly WebSocketCtor?: WebSocketCtor;
  /** Injected reconnect timer (deterministic in tests); defaults to `setTimeout`. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Backoff jitter source (deterministic in tests); defaults to `Math.random`. */
  readonly rand?: () => number;
  /**
   * How long a within-session reconnect may resume the sticky session before it is treated as a NEW go-live.
   *
   * This is the transport twin of the hook's visibility bound, and it exists because the two reconnect paths
   * are different. The hook re-creates the session on a visibility change; a DEAD SOCKET (a laptop sleep that
   * never fired visibilitychange) does NOT — scheduleReconnect reuses the sticky sessionId, and the DO's
   * existing-binding branch resumes from its durable cursor no matter what the client seeds. So the only way
   * to force "live from now" on that path is to drop the sessionId, which the staleness check below does.
   * Defaults high; the hook passes its own bound so the two agree.
   */
  readonly maxResumeGapMs?: number;
  /** Injected wall clock (deterministic in tests); defaults to `Date.now`. A DURATION source, so skew-safe. */
  readonly nowFn?: () => number;
}

export interface LiveEventsSession {
  /** Close the socket, cancel any pending reconnect, and go inert (idempotent). */
  stop(): void;
}

/** Reconnect backoff base (the first wait grows from here). Mirrors the CLI tunnel reconnect bounds. */
export const BACKOFF_BASE_MS = 500;
/** Reconnect backoff ceiling — never wait longer than this between attempts. */
export const BACKOFF_CAP_MS = 30_000;

/**
 * Capped exponential backoff with jitter (attempt is 1-based): half the capped delay is fixed and half is
 * random, so many tabs reconnecting after an engine blip don't synchronise (a thundering herd) yet never
 * wait below half the cap. Mirrors the CLI's `backoffMs` formula (packages/cli/src/retry.ts) — the web
 * worker can't import the CLI package, so the formula is restated here.
 */
export function backoffMs(
  attempt: number,
  rand: () => number = Math.random,
  base: number = BACKOFF_BASE_MS,
  cap: number = BACKOFF_CAP_MS,
): number {
  const capped = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(capped / 2 + rand() * (capped / 2));
}

/** Project the WS `EventSummary` frame to the browser-safe list item — drops orgId (never shown). */
function toItem(summary: EventSummary): EventSummaryItem {
  return {
    id: summary.id,
    endpointId: summary.endpointId,
    receivedAt: summary.receivedAt,
    provider: summary.provider,
    dedupKey: summary.dedupKey,
    dedupStrategy: summary.dedupStrategy,
    verified: summary.verified,
    verificationState: summary.verificationState,
  };
}

/**
 * Create + start a live-events session. Returns a handle whose `stop()` tears everything down. The session
 * mints a ticket, opens the `/listen` socket offering `[LISTEN_SUBPROTOCOL, "ticket." + ticket]`, marks
 * connected on the ReadyFrame, emits mapped items (+ acks their cursor) on EventFrames, tracks status, and
 * reconnects with capped exponential backoff on close/error — reusing the ready `sessionId` on the resume
 * query so the engine can rewind to where the tail left off.
 */
export function createLiveEventsSession(options: LiveEventsSessionOptions): LiveEventsSession {
  const {
    wsUrl,
    endpointId,
    mintTicket,
    onEvent,
    onStatus,
    onConnectionChange,
    onError,
    seedFrom,
    onCursor,
    WebSocketCtor = globalThis.WebSocket as unknown as WebSocketCtor,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rand = Math.random,
    maxResumeGapMs = 5 * 60 * 1000,
    nowFn = Date.now,
  } = options;

  let ws: WebSocketLike | null = null;
  let stopped = false;
  let attempt = 0;
  let sessionId: string | null = null;
  let reconnectHandle: unknown = null;
  // Wall-clock of the last proof the tail was alive (a ready or an event). A reconnect whose gap since this
  // exceeds maxResumeGapMs is a stale session, not a blip: drop the sticky sessionId so it restarts live.
  let lastActivityAt = 0;

  function detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectHandle !== null) return;
    attempt += 1;
    const delay = backoffMs(attempt, rand);
    reconnectHandle = setTimeoutFn(() => {
      reconnectHandle = null;
      void connect();
    }, delay);
  }

  function handleClose(): void {
    if (stopped) return;
    if (ws) {
      detach(ws);
      ws = null;
    }
    onConnectionChange("disconnected");
    scheduleReconnect();
  }

  function handleMessage(data: string | ArrayBuffer): void {
    const frame = parseServerFrame(data);
    if (!frame) return; // malformed / unknown → skip (never throw on untrusted input).
    switch (frame.type) {
      case "ready":
        sessionId = frame.sessionId;
        lastActivityAt = nowFn();
        attempt = 0; // a clean connect resets the backoff.
        onConnectionChange("connected");
        return;
      case "event":
        lastActivityAt = nowFn();
        onEvent(toItem(frame.summary));
        // Report the position BEFORE acking: this is what lets a paused tail resume exactly, so a tab switch
        // costs nothing. At-least-once means a resume may redeliver the last item; the list dedupes by id.
        onCursor?.(frame.cursor);
        // advisory ack — the inspection tail is at-least-once; acking lets the engine trim.
        ws?.send(encodeClientFrame({ type: "ack", cursor: frame.cursor }));
        return;
      case "status":
        onStatus({ caughtUp: frame.caughtUp, lag: frame.lag });
        return;
      case "error":
        // A recoverable server notice (e.g. a degraded poll) — not fatal on its own; keep the socket.
        return;
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    onConnectionChange("connecting");
    let minted: MintTicketResult;
    try {
      minted = await mintTicket(endpointId);
    } catch {
      if (stopped) return;
      onError?.("We couldn't reach the live stream. Retrying…");
      onConnectionChange("disconnected");
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    if (!minted.ok) {
      // A returned {ok:false} is a TERMINAL business refusal (e.g. the endpoint was deleted / isn't the
      // caller's) — permanent, so surface the reason and stop rather than re-mint forever. A transient
      // network fault is the `catch` above, which DOES reconnect. The user can toggle Live off/on to retry.
      onError?.(minted.error);
      stop();
      return;
    }

    // LIVE MEANS LIVE. Without a seed the DO's cursor stays unset, and unset means OLDEST-INCLUSIVE (its own
    // comment says so) — so turning Live on replayed the endpoint's whole retained history, newest last.
    // History is not live; the reader asked to watch what happens from now on.
    //
    // Two seeds, because "start watching" and "carry on watching" are different questions:
    //
    //   * NO seedFrom = a fresh go-live → `since=now`. The engine resolves it server-side to the head. It is
    //     NOT wall-clock, which is what makes it safe against the gapless watermark: it lands on the latest
    //     event AT/BELOW the watermark, so an event still in flight is delivered when it matures rather than
    //     skipped. A wall-clock instant would skip it — the gap the watermark exists to close.
    //   * seedFrom = the tail was PAUSED (hidden tab ⇒ the hook stops the session) and is resuming from the
    //     last cursor it saw. Those events arrived while Live was ON, so they are not history and dropping
    //     them would be a data-loss bug wearing the fix's clothes. `sinceCursor` is opaque + HMAC-verified by
    //     the DO, so the SEED costs no DB round trip on this path — the connect still runs backlogMeta, which
    //     is advisory. The hook bounds how stale a resume may be; a pause is an interruption, not an absence.
    //
    // COST, stated rather than glossed: `since=now` opts this connect into the DO's LOAD-BEARING seed
    // resolution, which 503s the upgrade if the tenant DB hiccups (the client then re-mints and retries on
    // backoff). Before this, the dashboard's only connect-time DB touch was backlogMeta, which is deliberately
    // advisory and never fails an upgrade. That is a real new dependency, and it is the trade we want: failing
    // closed and retrying beats connecting cheerfully and flooding the reader with history.
    //
    // Both only matter on a FIRST-BIND. A reconnect that still has its sticky sessionId lands on a DO that
    // already holds a binding, and listen-session's `existing` branch leaves the durable cursor untouched
    // without reading either header. The seed is what makes the NO-sessionId paths (remount, tab show, a
    // cold DO) correct — and those are the common ones, not the exotic ones.
    // A reconnect gone stale (a dead socket after a long sleep) is no longer a resume. Drop the sticky
    // sessionId so the engine mints a fresh one → a new DO → first-bind → `since=now`. Keeping it would land
    // on the same DO, whose existing-binding branch resumes from the durable cursor and floods the gap.
    const staleResume =
      sessionId !== null && lastActivityAt !== 0 && nowFn() - lastActivityAt > maxResumeGapMs;
    if (staleResume) sessionId = null;

    const params = new URLSearchParams({ endpointId });
    // A dropped-session reconnect is a fresh go-live: `since=now`, never the (now stale) resume cursor.
    if (seedFrom && !staleResume) params.set("sinceCursor", seedFrom);
    else params.set("since", "now");
    if (sessionId) params.set("sessionId", sessionId);
    const url = `${wsUrl}?${params.toString()}`;
    const protocols = [LISTEN_SUBPROTOCOL, LISTEN_TICKET_SUBPROTOCOL_PREFIX + minted.ticket];

    let socket: WebSocketLike;
    try {
      socket = new WebSocketCtor(url, protocols);
    } catch {
      onConnectionChange("disconnected");
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      // The engine confirms readiness with a ReadyFrame; we mark "connected" there, not on raw open.
    };
    socket.onmessage = (ev) => handleMessage(ev.data);
    socket.onclose = () => handleClose();
    socket.onerror = () => {
      // Some runtimes fire `error` without a following `close`; close ourselves so the reconnect path runs.
      if (ws === socket) {
        try {
          socket.close();
        } catch {
          // ignore — closing a already-dead socket can throw in some runtimes.
        }
        handleClose();
      }
    };
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (reconnectHandle !== null) {
      clearTimeoutFn(reconnectHandle);
      reconnectHandle = null;
    }
    if (ws) {
      detach(ws);
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    onConnectionChange("disconnected");
  }

  void connect();

  return { stop };
}
