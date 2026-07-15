// Application-level keepalive for the `wbhk listen` tunnel WebSocket.
//
// WHY: the engine's ListenSession DO sends NO frames during idle gaps (it only pushes on new events), and
// the `ws` client has no built-in keepalive — so during the sparse-event periods typical of testing, the
// tunnel socket sits idle. Intermediaries (NAT, proxies, the CF edge) silently drop idle WebSockets, or the
// socket goes half-open; without a heartbeat the client can't tell until the OS TCP timeout (tens of
// seconds), so the next event after a quiet period appears to "take ~30s". So we send the keepalive DATA
// MESSAGE `LISTEN_KEEPALIVE_PING` — NOT a protocol ping frame — which the engine's `setWebSocketAutoResponse`
// pair answers with a `pong` data message WITHOUT waking the hibernated DO (cheap). That `pong` arrives as a
// normal inbound message (parseServerFrame skips it), and — like any inbound frame — counts as "alive". If
// NOTHING arrives within the timeout the transport is dead, so we terminate it and let listen's reconnect
// loop reconnect (resuming from the durable cursor — at-least-once, no event loss). (Do NOT switch this to
// `ws.ping()`: a protocol ping frame is a different layer the engine's data-message auto-response never
// answers, so pongs would stop counting as activity and healthy sockets would be spuriously terminated.)
//
// SCOPE — this is TRANSPORT liveness. Because the edge auto-pongs, a pong proves only that the edge is
// reachable, not that the ListenSession DO behind it is still polling; a DO that wedged while the edge
// stayed up would keep the watchdog happy, and that case is bounded by the engine's server-side session
// lifetime cap (it force-closes → the client reconnects a fresh session). Detecting a wedged-DO-behind-a-
// live-edge faster needs a server-SENT heartbeat frame (so idle-healthy is distinguishable from wedged) —
// a follow-up. This change fixes the reported symptom: an idle socket silently dropped by an intermediary.

/** Send a ping ~every 20s: well inside common NAT/proxy idle windows so the tunnel stays warm. */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** Declare the socket dead after ≥50s of silence — but the check only runs on the ping tick, so real
 *  detection lands within `timeout + one interval` (≈50–70s). Long enough that a brief
 *  hiccup doesn't churn the connection, short enough to beat the multi-tens-of-seconds OS TCP timeout. */
export const HEARTBEAT_TIMEOUT_MS = 50_000;

export interface HeartbeatTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}

export interface HeartbeatActions {
  /** Send a keepalive ping (a data message the engine auto-answers) — keeps the socket warm + probes it. */
  ping: () => void;
  /** Force-close a socket that has gone silent, so the reconnect loop can recover it. */
  terminate: () => void;
}

/**
 * Build the watchdog's terminate action. Force-close the dead socket; but if `terminate()` itself throws
 * BEFORE the socket can emit its 'close' event, call `synthesizeClose` so the caller's per-connection
 * promise still settles and the reconnect loop isn't wedged forever (the very hang this whole change
 * prevents). Idempotent from the caller's side — a later real 'close' is a no-op once that promise settled.
 */
export function makeTerminateAction(
  terminate: () => void,
  synthesizeClose: () => void,
): () => void {
  return () => {
    try {
      terminate();
    } catch {
      synthesizeClose();
    }
  };
}

/**
 * Start a keepalive loop over one connected WebSocket. Returns `onActivity` (call it on every inbound frame
 * and pong to reset the liveness deadline) and `stop` (call it on close/error/teardown). On each interval:
 * if nothing has arrived within `timeoutMs`, terminate the socket (once); otherwise ping. Injected timers +
 * clock keep it deterministically unit-testable.
 */
export function startTunnelHeartbeat(
  timers: HeartbeatTimers,
  actions: HeartbeatActions,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): { onActivity: () => void; stop: () => void } {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  let lastActivity = timers.now();
  let stopped = false;
  const handle = timers.setInterval(() => {
    // No `if (stopped) return` guard: both stop paths clearInterval, so a real timer never re-fires the
    // callback after stopping — a guard here would be dead code. Idempotency of stop() is asserted in tests.
    if (timers.now() - lastActivity > timeoutMs) {
      // No inbound frame or pong within the window → the socket is dead/half-open. Tear it down once; the
      // `ws` 'close' event then fires and listen's reconnect loop opens a fresh socket.
      stopped = true;
      timers.clearInterval(handle);
      actions.terminate();
      return;
    }
    actions.ping();
  }, intervalMs);
  return {
    onActivity: () => {
      lastActivity = timers.now();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}
