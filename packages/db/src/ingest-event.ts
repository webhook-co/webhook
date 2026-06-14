// The PRODUCTION ingest write: the wbhk.my path's single-statement `SELECT ingest_event(...)`.
//
// Run as the dedicated webhook_ingest role (statement_timeout=5s; INSERT+SELECT on events only;
// non-owner, RLS-enforced). ONE top-level statement so set_config('app.current_org', ..., true) is
// transaction-local to that implicit transaction — no connection pinning on Hyperdrive's pooled
// connections (ADR / migration 0006). org_id is SERVER-derived from the token lookup, never client
// input; received_at is set by the events trigger, not here. The insert is ON CONFLICT
// (endpoint_id, dedup_key) DO NOTHING, so inserted=false is the dedup no-op success path.
//
// Capture is the floor: events land verified=false (external_id/verified/verification use the
// function defaults). Provider-signature verification populates them in a follow-up slice.

import { type Sql } from "./client";

/**
 * The full-fidelity capture row. Structurally matches the engine's IngestRow so the wbhk.my
 * handler wires `ingestEvent: (row) => insertIngestEvent(ingest, row)` without a second type.
 */
export interface IngestEventInput {
  readonly id: string;
  readonly orgId: string;
  readonly endpointId: string;
  readonly payloadR2Key: string;
  readonly payloadBytes: number;
  readonly dedupKey: string;
  readonly dedupStrategy: string;
  /** MIME from the request, or null. */
  readonly contentType: string | null;
  /** sha256(body) as raw bytes (bytea), or null. */
  readonly contentHash: Uint8Array | null;
  /** Captured headers as ordered name/value pairs (stored jsonb). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly provider: string | null;
  readonly providerEventId: string | null;
  readonly dedupBucket: number | null;
  /** Provider-signature verification outcome (best-effort at capture). false = unverified. */
  readonly verified: boolean;
  /** The structured verification diagnostic (stored jsonb), or null when not attempted. */
  readonly verification: unknown;
}

/**
 * Insert one captured event via ingest_event. Returns `{ inserted }` — false when the
 * (endpoint_id, dedup_key) conflict makes the insert a dedup no-op (still an ACK-worthy success).
 * `sql` MUST be the webhook_ingest client on a CACHE-DISABLED Hyperdrive binding.
 */
export async function insertIngestEvent(
  sql: Sql,
  row: IngestEventInput,
): Promise<{ inserted: boolean }> {
  // bytea wants a Buffer; jsonb is passed as a JSON string and cast. external_id stays null (no
  // SW external-id wiring yet); verified/verification carry the best-effort verification outcome.
  const contentHash = row.contentHash === null ? null : Buffer.from(row.contentHash);
  const verification = row.verification === null ? null : JSON.stringify(row.verification);
  const rows = await sql<{ inserted: boolean }[]>`
    select inserted from ingest_event(
      ${row.id}::uuid,
      ${row.orgId}::uuid,
      ${row.endpointId}::uuid,
      ${row.payloadR2Key},
      ${row.payloadBytes}::bigint,
      ${row.dedupKey},
      ${row.dedupStrategy},
      ${row.contentType},
      ${contentHash}::bytea,
      ${JSON.stringify(row.headers)}::jsonb,
      ${row.provider},
      ${row.providerEventId},
      ${row.dedupBucket}::bigint,
      null::text,
      ${row.verified},
      ${verification}::jsonb
    )`;
  // ingest_event ALWAYS returns exactly one (event_id, inserted) row. Anything else (an empty or
  // multi-row result) means a broken contract — fail loud so the caller 500s and the provider
  // retries, never silently ACK an unpersisted event as a dedup no-op.
  if (rows.length !== 1) {
    throw new Error(`ingest_event returned ${rows.length} rows, expected exactly 1`);
  }
  return { inserted: rows[0]!.inserted === true };
}
