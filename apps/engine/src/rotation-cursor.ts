// Resume points for the cron rotations that page through orgs (the Stripe transport reconciler today).
//
// A rotation cursor is a small piece of state with an outsized failure mode: a cron that reads a cursor
// pointing past the end of its list reconciles NOTHING, reports zero drift, and looks exactly like a clean
// run. So the two operations here are deliberately explicit — parse defensively, and persist the WRAP as a
// delete rather than writing a sentinel that a later reader would have to interpret.

/** A canonical lowercase UUID, the shape every org id takes. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ParsedCursor {
  /** The resume point, or null to start from the beginning of the list. */
  readonly cursor: string | null;
  /** True when a stored value existed but was NOT a usable cursor — an alarm, not a silent restart. */
  readonly malformed: boolean;
}

/**
 * Interpret a stored cursor.
 *
 * Anything that is not a canonical UUID restarts the rotation from the beginning rather than being passed
 * to SQL. That matters concretely: `org_id` is a uuid column, so a non-uuid cursor is a Postgres error
 * (`invalid input syntax for type uuid`), not an empty filter — the cron would fail every tick until
 * someone cleared the key by hand.
 *
 * Restarting is always SAFE for a rotation: the worst case is re-checking orgs that were already checked,
 * which for a read-only reconciliation costs a pass and nothing else. But it is never silent — `malformed`
 * lets the caller say so, because a cursor that keeps arriving corrupted means the rotation is not
 * advancing and coverage is not what the counters imply.
 */
export function parseRotationCursor(raw: string | null | undefined): ParsedCursor {
  if (raw === null || raw === undefined || raw === "") return { cursor: null, malformed: false };
  if (!UUID_RE.test(raw)) return { cursor: null, malformed: true };
  return { cursor: raw, malformed: false };
}

/** The minimal KV surface a rotation cursor needs. */
export interface RotationCursorStore {
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/**
 * Persist where the next pass should resume.
 *
 * A null `nextCursor` means the pass reached the end of the list, so the key is DELETED — the next read
 * then starts from the beginning. Writing a sentinel instead would leave a value every reader has to know
 * how to interpret, and a reader that got it wrong would start past the end and reconcile nothing.
 */
export async function persistRotationCursor(
  store: RotationCursorStore,
  key: string,
  nextCursor: string | null,
): Promise<void> {
  if (nextCursor === null) {
    await store.delete(key);
    return;
  }
  await store.put(key, nextCursor);
}
