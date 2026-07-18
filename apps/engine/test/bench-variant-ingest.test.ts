import { describe, expect, it } from "vitest";

import { type BenchInsert, variantI } from "../src/bench/variants";

// variantI is the p99-bench variant that routes the FULL ingest orchestration through the real
// handleIngest (faked resolve/verify; real R2 put + real ingest_event insert), closing the gap where the
// old bench measured only the R2 PUT + insert (variant R) and never exercised readCappedBody /
// deriveDedup / payloadR2Key. This test proves it goes through handleIngest to both durable steps — so a
// load run's p99 reflects the whole ACK budget, not a shortcut. The load run itself is deployed
// separately (wrangler.bench.jsonc); here we drive it with fakes to pin the orchestration.

const P: BenchInsert = {
  id: "be000000-0000-4000-8000-000000000010",
  orgId: "be000000-0000-4000-8000-000000000001",
  endpointId: "be000000-0000-4000-8000-000000000002",
  dedupKey: "be000000-0000-4000-8000-000000000010",
  payloadR2Key: "org/be/ep/be/000",
  payloadBytes: 512,
  dedupStrategy: "content_hash",
};

/** A minimal postgres.js `Sql` stand-in: a tagged-template fn resolving to one `inserted` row, plus the
 *  `.json` passthrough insertIngestEvent uses. Records each call so the test can assert the insert ran. */
function fakeSql() {
  const calls: unknown[][] = [];
  const fn = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve([{ inserted: true }]);
  }) as unknown as Parameters<typeof variantI>[0];
  (fn as unknown as { json: (x: unknown) => unknown }).json = (x) => x;
  return { sql: fn, calls };
}

/** A minimal R2 bucket stand-in that records puts. */
function fakeR2() {
  const puts: { key: string; bytes: number }[] = [];
  const r2 = {
    put: async (key: string, body: ArrayBuffer | ArrayBufferView) => {
      puts.push({ key, bytes: body instanceof ArrayBuffer ? body.byteLength : body.byteLength });
    },
  } as unknown as Parameters<typeof variantI>[1];
  return { r2, puts };
}

describe("variantI — the full-handleIngest p99 bench variant", () => {
  it("routes through handleIngest to a real R2 put AND ingest_event insert (not a raw insert)", async () => {
    const { sql, calls } = fakeSql();
    const { r2, puts } = fakeR2();

    const res = await variantI(sql, r2, P);

    expect(res.inserted).toBe(true); // the insert step ran and reported inserted
    expect(puts.length).toBe(1); // the durable-before-ACK R2 put ran (the half variant R measured)
    expect(calls.length).toBeGreaterThan(0); // ingest_event was executed against the DB

    // The R2 key is CONTENT-ADDRESSED (ends in a SHA-256 that the real deriveDedup + payloadR2Key
    // computed over the streamed body) — NOT the input p.payloadR2Key. This pins the WHOLE orchestration:
    // a variant-R-shaped shortcut that reused the input key or skipped the two SHA-256s would fail here,
    // which is the entire reason variant I exists over variant R.
    expect(puts[0]!.key).toMatch(/[0-9a-f]{64}$/);
    expect(puts[0]!.key).not.toBe(P.payloadR2Key);
    expect(typeof res.r2Ms).toBe("number"); // the R2 put was timed
    expect(typeof res.dbMs).toBe("number"); // the insert was timed
  });

  it("puts a body of the requested size (the orchestration read + hashed the real body)", async () => {
    const { sql } = fakeSql();
    const { r2, puts } = fakeR2();

    await variantI(sql, r2, { ...P, payloadBytes: 4096 });

    expect(puts[0]!.bytes).toBe(4096); // readCappedBody streamed the full body through to the R2 put
  });
});
