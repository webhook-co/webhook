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
  readonly WebSocketCtor?: WebSocketCtor;
  /** Injected reconnect timer (deterministic in tests); defaults to `setTimeout`. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Backoff jitter source (deterministic in tests); defaults to `Math.random`. */
  readonly rand?: () => number;
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
    WebSocketCtor = globalThis.WebSocket as unknown as WebSocketCtor,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rand = Math.random,
  } = options;

  let ws: WebSocketLike | null = null;
  let stopped = false;
  let attempt = 0;
  let sessionId: string | null = null;
  let reconnectHandle: unknown = null;

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
        attempt = 0; // a clean connect resets the backoff.
        onConnectionChange("connected");
        return;
      case "event":
        onEvent(toItem(frame.summary));
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

    // `since=now` is load-bearing: WITHOUT it the DO's seed cursor stays unset, and unset means
    // OLDEST-INCLUSIVE (its own comment says so). Live then replayed the endpoint's entire retained history,
    // oldest first — so the newest event, the only reason anyone turns Live on, arrived last. The engine has
    // always accepted the grammar (now|beginning|<duration>|<RFC3339>) and resolves it server-side; the
    // dashboard just never asked.
    //
    // Sent unconditionally, including on a resume. A reconnect carries the sticky sessionId to a DO that
    // already holds a binding, and listen-session's `existing` branch leaves the durable cursor untouched
    // without ever reading this header — so the resume stays seamless and nothing in the gap is skipped. If
    // the DO is gone, the reconnect re-enters first-bind and this skips the gap instead of replaying
    // everything, which is the right failure for a live tail.
    const params = new URLSearchParams({ endpointId, since: "now" });
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
