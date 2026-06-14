import type { Sql } from "@webhook-co/db";

// The four RLS-insert variants for the WS-E p99 ingest benchmark (wedge §0.2). Each performs ONE
// logical "ingest insert" and returns the DB round-trip time (performance.now() around the DB call)
// plus whether a row was inserted. The driver layers end-to-end ACK timing on top. The variants
// differ ONLY in how per-request tenant context + the insert reach Postgres through Hyperdrive's
// transaction-mode pool:
//
//   A — bare INSERT into events_bench (a faithful copy of events with NO row-level security): the
//       floor. Measures the raw insert with zero RLS policy evaluation.
//   B — `SELECT ingest_event(...)`: the PROPOSED path. One top-level statement, so set_config(...,
//       true) is transaction-local to that one implicit transaction; RLS-on, FORCE RLS, non-owner.
//       One round-trip, no connection pinning.
//   C — explicit BEGIN; SET LOCAL; INSERT; COMMIT: the documented Hyperdrive ANTI-PATTERN. The
//       transaction PINS a pooled connection across multiple round-trips, starving other isolates.
//   D — combined simple-query batch `SET app.current_org=...; INSERT ...` (no function, no explicit
//       BEGIN): one round-trip, RLS-on, but the SET is SESSION-level (it persists on the physical
//       connection until Hyperdrive resets it on pool return — a safety caveat vs B's local scope).

/** A single benchmark insert. All values are server-derived (seeded org/endpoint, generated keys). */
export interface BenchInsert {
  readonly id: string;
  readonly orgId: string;
  readonly endpointId: string;
  /** Unique per request so each call is a real INSERT, not an ON CONFLICT dedup no-op. */
  readonly dedupKey: string;
  readonly payloadR2Key: string;
  readonly payloadBytes: number;
  readonly dedupStrategy: string;
}

export interface VariantResult {
  readonly inserted: boolean;
  /** DB round-trip in milliseconds (the span the variants actually differ on). */
  readonly dbMs: number;
}

export type Variant = "A" | "B" | "C" | "D";
export const VARIANTS: readonly Variant[] = ["A", "B", "C", "D"];

/** A — bare INSERT into the RLS-off floor table. */
export async function variantA(sql: Sql, p: BenchInsert): Promise<VariantResult> {
  const t0 = performance.now();
  const rows = await sql`
    insert into events_bench (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
    values (${p.id}, ${p.orgId}, ${p.endpointId}, ${p.payloadR2Key}, ${p.payloadBytes}, ${p.dedupKey}, ${p.dedupStrategy})
    on conflict (endpoint_id, dedup_key) do nothing
    returning id`;
  return { inserted: rows.length === 1, dbMs: performance.now() - t0 };
}

/** B — the proposed single-statement `SELECT ingest_event(...)`, RLS-on. */
export async function variantB(sql: Sql, p: BenchInsert): Promise<VariantResult> {
  const t0 = performance.now();
  const rows = await sql<{ inserted: boolean }[]>`
    select inserted from ingest_event(
      ${p.id}::uuid, ${p.orgId}::uuid, ${p.endpointId}::uuid,
      ${p.payloadR2Key}, ${p.payloadBytes}::bigint, ${p.dedupKey}, ${p.dedupStrategy})`;
  return { inserted: rows[0]?.inserted === true, dbMs: performance.now() - t0 };
}

/** C — explicit transaction (SET LOCAL + INSERT). Pins a Hyperdrive pooled connection — the anti-pattern. */
export async function variantC(sql: Sql, p: BenchInsert): Promise<VariantResult> {
  const t0 = performance.now();
  const inserted = await sql.begin(async (tx) => {
    // set_config(name, value, true) is the parameterized `SET LOCAL` (transaction-scoped).
    await tx`select set_config('app.current_org', ${p.orgId}, true)`;
    const rows = await tx`
      insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
      values (${p.id}, ${p.orgId}, ${p.endpointId}, ${p.payloadR2Key}, ${p.payloadBytes}, ${p.dedupKey}, ${p.dedupStrategy})
      on conflict (endpoint_id, dedup_key) do nothing
      returning id`;
    return rows.length === 1;
  });
  return { inserted: Boolean(inserted), dbMs: performance.now() - t0 };
}

/**
 * D — combined simple-query batch (SESSION `SET` + INSERT) in one round-trip, no function. Values are
 * server-derived; the dedup_key / keys are generated (no quotes), so the simple-query interpolation
 * is benchmark-safe. The SESSION set persists on the connection until Hyperdrive resets it on return
 * — the safety caveat that makes B (transaction-local) the safer of the two one-round-trip paths.
 */
export async function variantD(sql: Sql, p: BenchInsert): Promise<VariantResult> {
  const t0 = performance.now();
  await sql.unsafe(
    `set app.current_org = '${p.orgId}';
     insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
     values ('${p.id}', '${p.orgId}', '${p.endpointId}', '${p.payloadR2Key}', ${p.payloadBytes}, '${p.dedupKey}', '${p.dedupStrategy}')
     on conflict (endpoint_id, dedup_key) do nothing`,
  );
  // The simple-query protocol doesn't surface a row count here; the unique dedup_key guarantees an
  // insert, so report true. (Correctness — that D actually inserts under RLS — is asserted in tests.)
  return { inserted: true, dbMs: performance.now() - t0 };
}

export const VARIANT_FNS: Record<Variant, (sql: Sql, p: BenchInsert) => Promise<VariantResult>> = {
  A: variantA,
  B: variantB,
  C: variantC,
  D: variantD,
};
