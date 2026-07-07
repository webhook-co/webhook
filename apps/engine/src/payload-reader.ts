// The bounded-inline-body core for triggers.wait (S5 Slice C2), factored out of the PayloadReader
// WorkerEntrypoint (apps/engine/src/index.ts) so the tenant-isolation + bounded-read logic is provable with
// injected deps — exactly like guardedDeliver's SSRF guard. The WorkerEntrypoint wires the real deps: an
// RLS-scoped event lookup (webhook_app on HYPERDRIVE_TENANT) whose connection is released BEFORE the R2
// reads, and a capped R2 range read. Everything security-load-bearing lives here: the readPayloadKey
// org/endpoint fence on the STORED key (a poisoned column can't point at another tenant — and the R2 read is
// never even attempted when the fence fails), the per-event failure isolation, and the 0-byte short-circuit.

import {
  boundedBodyFromBytes,
  MAX_INLINE_BODY_BYTES,
  readPayloadKey,
  type BoundedPayloadBody,
  type ReadBoundedBodiesArgs,
} from "@webhook-co/shared";

/** One event row the RLS lookup returns (only the caller-org's rows resolve; a cross-org/unknown id absent). */
export interface PayloadEventRow {
  readonly id: string;
  readonly endpoint_id: string;
  /** The STORED R2 key — fenced with readPayloadKey before use (never trusted verbatim). */
  readonly payload_r2_key: string;
  /** `bigint` column: postgres.js returns it as a JS string, so accept both and Number() it. */
  readonly payload_bytes: string | number;
  readonly content_type: string | null;
}

export interface PayloadReaderDeps {
  /**
   * RLS-scoped event lookup: returns ONLY the given org's rows for the given ids (a cross-org / unknown id
   * is simply absent). The implementation holds its DB connection for exactly this call and releases it
   * before returning, so the subsequent R2 reads never pin a connection.
   */
  readonly lookupEvents: (
    orgId: string,
    eventIds: readonly string[],
  ) => Promise<readonly PayloadEventRow[]>;
  /** Range-read at most `cap` bytes (offset 0) of the R2 object at the already-fenced `key`; null if absent. */
  readonly readObject: (key: string, cap: number) => Promise<Uint8Array | null>;
}

/**
 * Resolve a bounded inline body for each requested event id. Ordering + arity mirror `eventIds`. An event is
 * `found:false` (body null, no oracle) when it is unknown/cross-org (absent from the RLS lookup), its stored
 * key fails the org/endpoint fence, its R2 object is missing, or its individual R2 read throws — a per-event
 * failure NEVER rejects the whole page. A 0-byte body short-circuits to an explicit empty body (no doomed
 * offset-0 range read on an empty object). Bodies are fetched CONCURRENTLY (one round-trip wide, not N deep).
 */
export async function readBoundedBodiesCore(
  deps: PayloadReaderDeps,
  args: ReadBoundedBodiesArgs,
): Promise<BoundedPayloadBody[]> {
  const { orgId, eventIds } = args;
  if (eventIds.length === 0) return [];
  const cap = Math.max(1, Math.min(args.maxBytesEach, MAX_INLINE_BODY_BYTES));
  const notFound = (eventId: string): BoundedPayloadBody => ({
    eventId,
    found: false,
    body: null,
    encoding: "utf8",
    byteLength: 0,
    truncated: false,
    contentType: null,
  });

  const rows = await deps.lookupEvents(orgId, eventIds);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return Promise.all(
    eventIds.map(async (eventId): Promise<BoundedPayloadBody> => {
      const row = byId.get(eventId);
      if (row === undefined) return notFound(eventId);
      // Fence the STORED key to the caller's org/endpoint prefix — a poisoned column can't point at another
      // tenant's object, and a fence miss skips the R2 read entirely (no probe).
      const key = readPayloadKey(orgId, row.endpoint_id, row.payload_r2_key);
      if (key === null) return notFound(eventId);
      const storedBytes = Number(row.payload_bytes);
      // A 0-byte captured body is an empty R2 object; an offset-0 range read on it is unsatisfiable (R2 can
      // 416/throw). Short-circuit to an explicit empty body — honest (found:true) and never probes R2.
      if (storedBytes === 0) {
        return {
          eventId,
          found: true,
          body: "",
          encoding: "utf8",
          byteLength: 0,
          truncated: false,
          contentType: row.content_type,
        };
      }
      try {
        const bytes = await deps.readObject(key, cap);
        if (bytes === null) return notFound(eventId);
        return {
          eventId,
          found: true,
          contentType: row.content_type,
          ...boundedBodyFromBytes(bytes, storedBytes),
        };
      } catch {
        return notFound(eventId);
      }
    }),
  );
}
