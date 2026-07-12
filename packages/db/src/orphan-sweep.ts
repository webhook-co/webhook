// The orphan-sweep DB seam (S6c-iii). An "orphan" is an R2 payload object with NO matching `events` row —
// it exists because ingest is DURABLE-BEFORE-ACK (the body is PUT to R2 first, then the metadata row is
// inserted): if the insert fails, the R2 body is stranded (the provider's retry re-PUTs the SAME
// content-addressed key, so orphans don't churn — but a permanently-failed insert leaves one). The inverse
// also lands here: a retention prune that deleted the row but crashed before deleting R2. Both are objects
// with no row.
//
// This is the anti-join half: given a batch of candidate R2 keys, return the SET that DO have an `events`
// row (deleted-or-not — a tombstoned event keeps its row + key until the retention prune hard-deletes it,
// and its body is the event-payload-purge cron's job, NOT an orphan). The caller deletes the REST. Runs as
// the cross-org `webhook_retention` role (migration 0053 grants it `select (…, payload_r2_key) on events`
// under a role-targeted `USING (true)` policy), so a single query resolves keys spanning many orgs.

import { type Sql } from "./client";

/**
 * Of `keys`, the subset that currently have an `events` row (any org, tombstoned or not). Orphans are the
 * complement. Empty `keys` → empty set (no query). One bounded `= any($1)` over the page the caller listed.
 */
export async function existingPayloadKeys(
  retention: Sql,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const rows = await retention<{ payload_r2_key: string }[]>`
    select payload_r2_key from events where payload_r2_key in ${retention(keys as string[])}`;
  return new Set(rows.map((r) => r.payload_r2_key));
}
