import { advance, parseState, receiptKey, KV_STATE_KEY, type CanaryState } from "./canary";

/**
 * The scheduled half of the delivery canary — the side effects, kept apart from the pure state
 * machine in `canary.ts` so the interesting logic stays testable without a network.
 */

/** The narrow store surface a tick needs, so tests need no KV binding. */
export interface CanaryStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface TickDeps {
  readonly store: CanaryStore;
  /** POST the synthetic event to the live ingest URL. Resolves on 2xx, throws otherwise. */
  readonly send: (nonce: string) => Promise<void>;
  readonly nonce: () => string;
  readonly now: () => number;
}

/**
 * Receipts outlive one correlation window but must not accumulate. Two hours is far longer than the
 * 5-minute tick — so a slow round-trip is never missed because its receipt expired — while still
 * bounding the keyspace without a sweep.
 */
export const RECEIPT_TTL_SECONDS = 2 * 60 * 60;

/**
 * Run one canary tick: correlate the previous nonce, then arm a new one.
 *
 * A FAILED SEND STILL ADVANCES THE STATE. It is tempting to bail out early, but the send failing is
 * itself the signal we want: the state records that a nonce went out and no receipt came back, and
 * the component goes stale on schedule. Returning early would leave the previous nonce armed
 * forever and could let an old receipt correlate against it much later, reporting a healthy
 * pipeline that has actually been down for hours.
 */
export async function runCanaryTick(deps: TickDeps): Promise<CanaryState> {
  const { store, send, nonce, now } = deps;

  const prev = parseState(await store.get(KV_STATE_KEY));

  // Correlate the PREVIOUS tick's nonce. Deferring by a tick gives the pipeline a full interval to
  // complete rather than forcing an inline wait.
  let receiptAt: number | null = null;
  if (prev.inFlight !== null) {
    const raw = await store.get(receiptKey(prev.inFlight.nonce));
    const parsed = raw === null ? null : Number(raw);
    if (parsed !== null && Number.isFinite(parsed)) receiptAt = parsed;
  }

  const newNonce = nonce();
  const sentAt = now();
  await send(newNonce).catch(() => undefined);

  const next = advance(prev, { receiptAt, newNonce, now: sentAt });
  await store.put(KV_STATE_KEY, JSON.stringify(next));
  return next;
}

/** Record that a delivered canary event arrived. Called by the sink after signature verification. */
export async function recordReceipt(store: CanaryStore, nonce: string, at: number): Promise<void> {
  await store.put(receiptKey(nonce), String(at), { expirationTtl: RECEIPT_TTL_SECONDS });
}

/** Read persisted canary state. */
export async function readState(store: CanaryStore): Promise<CanaryState> {
  return parseState(await store.get(KV_STATE_KEY));
}
