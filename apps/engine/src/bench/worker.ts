import { createClient } from "@webhook-co/db";

import { VARIANT_FNS, VARIANTS, variantR, type BenchInsert, type Variant } from "./variants";

// The p99 ingest benchmark Worker. A throwaway, separately-deployed Worker
// (wrangler.bench.jsonc) that reuses the production-shaped Hyperdrive config (query caching OFF,
// connecting as webhook_ingest) so the numbers reflect the real ingest hot path. `POST /run/:variant`
// performs ONE ingest insert via that variant and returns the DB round-trip + total handler time; the
// driver (apps/engine/bench/driver.mjs) fires the load scenarios and aggregates p50–p99.9.
//
// Not part of the production engine: kept out of apps/engine/src/index.ts so it never ships on a real
// route. Deployed only for the benchmark window, then torn down with the bench Neon branch.

interface BenchEnv {
  HYPERDRIVE: Hyperdrive;
  /** Throwaway R2 bucket for variant R (the durable-before-ACK R2 PUT). */
  R2: R2Bucket;
}

const BENCH_ORG = "be000000-0000-4000-8000-000000000001";
const BENCH_ENDPOINT = "be000000-0000-4000-8000-000000000002";

const isVariant = (s: string): s is Variant => (VARIANTS as readonly string[]).includes(s);
// Bound the variant-R body size (?size=) so a stray query value can't allocate without limit.
const MAX_BODY_BYTES = 1_000_000;

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const url = new URL(request.url);
    // A-D run the DB-insert variants; R adds the R2 PUT in front (durable-before-ACK).
    const variantRaw = /^\/run\/([A-DR])$/.exec(url.pathname)?.[1];
    if (variantRaw === undefined) {
      return new Response("not found", { status: 404 });
    }

    // Variant R sweeps a realistic body size (?size=, default 5 KB ~ the PRD avg payload); the
    // DB-only variants keep the original small body so their numbers stay comparable to WS-E.
    const sizeParam = Number.parseInt(url.searchParams.get("size") ?? "5120", 10);
    const bodyBytes =
      variantRaw === "R" ? Math.min(Math.max(sizeParam || 5120, 1), MAX_BODY_BYTES) : 128;

    // A fresh id per request → a unique dedup_key → a real INSERT (not an ON CONFLICT dedup no-op).
    const id = crypto.randomUUID();
    const payload: BenchInsert = {
      id,
      orgId: BENCH_ORG,
      endpointId: BENCH_ENDPOINT,
      dedupKey: id,
      payloadR2Key: `org/${BENCH_ORG}/ep/${BENCH_ENDPOINT}/${id}`,
      payloadBytes: bodyBytes,
      dedupStrategy: "content_hash",
    };

    // One client per request (the Workers idiom): it connects to the local Hyperdrive proxy (fast);
    // Hyperdrive owns the upstream Neon pool, where variant C's pinned transactions saturate.
    const sql = createClient(env.HYPERDRIVE.connectionString, { max: 1 });
    try {
      const t0 = performance.now();
      const result =
        variantRaw === "R"
          ? await variantR(sql, env.R2, payload)
          : isVariant(variantRaw)
            ? await VARIANT_FNS[variantRaw](sql, payload)
            : null;
      if (result === null) return new Response("not found", { status: 404 });
      return Response.json({
        variant: variantRaw,
        inserted: result.inserted,
        dbMs: result.dbMs,
        r2Ms: result.r2Ms,
        bodyBytes,
        totalMs: performance.now() - t0,
      });
    } catch (err) {
      return Response.json({ variant: variantRaw, error: String(err) }, { status: 500 });
    } finally {
      await sql.end();
    }
  },
} satisfies ExportedHandler<BenchEnv>;
