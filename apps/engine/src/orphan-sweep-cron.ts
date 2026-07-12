// The R2 orphan-reconcile sweep (S6c-iii). Pure + dependency-injected so it unit-tests with fakes; the
// engine's scheduled() handler wires the real deps (an R2 list/delete over R2_PAYLOADS, a cross-org
// `events.payload_r2_key` anti-join over the webhook_retention connection, and a KV-persisted list cursor).
//
// An ORPHAN is an R2 payload object with NO matching `events` row. Ingest is DURABLE-BEFORE-ACK (ADR-0013):
// the body is PUT to R2 first, then the metadata row is inserted — so a permanently-failed insert strands
// the body. (A provider RETRY re-PUTs the SAME content-addressed key, so orphans don't churn; the inverse —
// a retention prune that deleted the row but crashed before deleting R2 — also lands here.) Orphans are
// bounded and harmless (just storage), so this sweep is deliberately conservative.
//
// THREE safety properties, in order — a false delete would destroy a legitimate event's body:
//   1. AGE FENCE: skip any object younger than `safetyWindowMs`. Between the R2 PUT and the events insert
//      the object exists with NO row yet — deleting it there would be data loss. The window is set FAR above
//      any PUT→insert latency, so only long-stranded objects are ever considered.
//   2. PREFIX FENCE: skip any key that isn't a well-formed `org/{uuid}/ep/{uuid}/{hash}` (the readPayloadKey
//      shape). Never delete a malformed or foreign object.
//   3. ANTI-JOIN: of the aged, well-formed candidates, delete ONLY the keys with no `events` row (any org,
//      tombstoned-or-not — a tombstone keeps its row + key; its body is the event-payload-purge cron's job).
// Bounded per tick (one R2 list page) + cursor-resumed across ticks, so a huge bucket drains over many ticks.

/**
 * Parse the ORPHAN_SWEEP_DELETE deploy var into the delete-enable flag. FAIL-SAFE: only the exact
 * (trimmed, lowercased) string `"true"` arms the irreversible delete; unset / `""` / `"false"` / `"1"` /
 * anything else stays COUNT-ONLY. Isolated + tested so the one line that gates a cross-org R2 delete can't
 * silently drift (e.g. treating `"1"` or any non-empty value as enabled).
 */
export function parseOrphanSweepDelete(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/** One R2 object considered for sweeping: its key + when it was uploaded (ms since epoch). */
export interface OrphanCandidate {
  readonly key: string;
  readonly uploadedMs: number;
}

export interface OrphanSweepDeps {
  /** The persisted R2-list cursor (KV). null = start a fresh scan from the beginning of the bucket. */
  readCursor: () => Promise<string | null>;
  /** List a bounded page of payload objects (the `org/` prefix), resuming from `cursor`. `cursor: null` in
   *  the result means the listing is EXHAUSTED (this was the last page). */
  listPage: (
    cursor: string | null,
    limit: number,
  ) => Promise<{ objects: readonly OrphanCandidate[]; cursor: string | null }>;
  /** True when `key` is a well-formed `org/{orgId}/ep/{endpointId}/{hash}` object key (the readPayloadKey
   *  principal-fence shape). A key that fails is skipped, never deleted (prefix fence). */
  validKey: (key: string) => boolean;
  /** Of these keys, the SET that HAVE an `events` row (cross-org anti-join). Orphans are the complement. */
  existingKeys: (keys: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Delete the given R2 payload objects (idempotent — an already-gone key is a no-op). */
  deleteR2: (keys: string[]) => Promise<void>;
  /**
   * Whether to ACTUALLY delete identified orphans. `false` = COUNT-ONLY: the sweep finds + reports orphans
   * (`result.orphans`) but calls no `deleteR2`. This is the safe default for an irreversible cross-org R2
   * delete — a first pass runs observably so the counts can be eyeballed before deletion is switched on.
   */
  deleteEnabled: boolean;
  /** Persist the next cursor (KV). null = the scan is exhausted; the next tick restarts from the beginning. */
  writeCursor: (cursor: string | null) => Promise<void>;
  /** Injected wall clock (ms). */
  now: number;
  /** Objects younger than this (ms) are SKIPPED — the PUT→insert in-flight window. */
  safetyWindowMs: number;
  /** Max objects to list + consider per tick. */
  pageSize: number;
  /** Optional structured logger; only non-PII fields (counts) are passed — never a raw key (its prefix
   *  names an org/endpoint). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OrphanSweepResult {
  /** Objects listed this tick. */
  readonly scanned: number;
  /** Orphans IDENTIFIED this tick (aged + well-formed + no events row) — what would be deleted. */
  readonly orphans: number;
  /** Orphans actually deleted this tick (0 in count-only mode, i.e. `deleteEnabled: false`). */
  readonly deleted: number;
  /** Objects skipped this tick because they're younger than the safety window (in-flight guard). */
  readonly skippedYoung: number;
  /** Objects skipped this tick because their key isn't a well-formed prefix (never deleted). */
  readonly skippedFenced: number;
  /** True when this tick reached the end of the bucket (the cursor was reset to start over). */
  readonly exhausted: boolean;
}

/** Sweep one bounded page of R2 payload objects, deleting only true orphans. */
export async function runOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const cursor = await deps.readCursor();
  const { objects, cursor: next } = await deps.listPage(cursor, deps.pageSize);

  let skippedYoung = 0;
  let skippedFenced = 0;
  const candidates: string[] = [];
  for (const o of objects) {
    // 1. AGE FENCE — never touch an object that could still be an in-flight event's body.
    if (deps.now - o.uploadedMs < deps.safetyWindowMs) {
      skippedYoung += 1;
      continue;
    }
    // 2. PREFIX FENCE — never delete a malformed/foreign key.
    if (!deps.validKey(o.key)) {
      skippedFenced += 1;
      continue;
    }
    candidates.push(o.key);
  }

  // 3. ANTI-JOIN — identify the aged, well-formed keys with no events row; delete them only when enabled.
  let orphans = 0;
  let deleted = 0;
  if (candidates.length > 0) {
    const existing = await deps.existingKeys(candidates);
    const orphanKeys = candidates.filter((k) => !existing.has(k));
    orphans = orphanKeys.length;
    if (orphanKeys.length > 0 && deps.deleteEnabled) {
      await deps.deleteR2(orphanKeys);
      deleted = orphanKeys.length;
    }
  }

  // Advance the cursor. `next === null` ⇒ the bucket is fully scanned; persist null so the next tick starts
  // over (young objects skipped this pass are re-examined then — by which point they've either gained a row
  // or aged into a real orphan). The cursor points PAST what we listed, so a crash mid-tick simply re-lists
  // from the saved cursor without skipping (deletes are idempotent).
  await deps.writeCursor(next);
  const exhausted = next === null;
  deps.log?.("orphan_sweep.done", {
    scanned: objects.length,
    orphans,
    deleted,
    deleteEnabled: deps.deleteEnabled,
    skippedYoung,
    skippedFenced,
    exhausted,
  });
  return { scanned: objects.length, orphans, deleted, skippedYoung, skippedFenced, exhausted };
}
