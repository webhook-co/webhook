import { createClient } from "@webhook-co/db";

import { VARIANT_FNS, VARIANTS, type BenchInsert, type Variant } from "./variants";

// The WS-E benchmark Worker (wedge §0.2). A throwaway, separately-deployed Worker
// (wrangler.bench.jsonc) that reuses the production-shaped Hyperdrive config (query caching OFF,
// connecting as webhook_ingest) so the numbers reflect the real ingest hot path. `POST /run/:variant`
// performs ONE ingest insert via that variant and returns the DB round-trip + total handler time; the
// driver (apps/engine/bench/driver.mjs) fires the load scenarios and aggregates p50–p99.9.
//
// Not part of the production engine: kept out of apps/engine/src/index.ts so it never ships on a real
// route. Deployed only for the benchmark window, then torn down with the bench Neon branch.

interface BenchEnv {
  HYPERDRIVE: Hyperdrive;
}

const BENCH_ORG = "be000000-0000-4000-8000-000000000001";
const BENCH_ENDPOINT = "be000000-0000-4000-8000-000000000002";

const isVariant = (s: string): s is Variant => (VARIANTS as readonly string[]).includes(s);

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const variantRaw = /^\/run\/([A-D])$/.exec(new URL(request.url).pathname)?.[1];
    if (variantRaw === undefined || !isVariant(variantRaw)) {
      return new Response("not found", { status: 404 });
    }
    const variant = variantRaw;

    // A fresh id per request → a unique dedup_key → a real INSERT (not an ON CONFLICT dedup no-op).
    const id = crypto.randomUUID();
    const payload: BenchInsert = {
      id,
      orgId: BENCH_ORG,
      endpointId: BENCH_ENDPOINT,
      dedupKey: id,
      payloadR2Key: `org/${BENCH_ORG}/ep/${BENCH_ENDPOINT}/${id}`,
      payloadBytes: 128,
      dedupStrategy: "content_hash",
    };

    // One client per request (the Workers idiom): it connects to the local Hyperdrive proxy (fast);
    // Hyperdrive owns the upstream Neon pool, where variant C's pinned transactions saturate.
    const sql = createClient(env.HYPERDRIVE.connectionString, { max: 1 });
    try {
      const t0 = performance.now();
      const { inserted, dbMs } = await VARIANT_FNS[variant](sql, payload);
      return Response.json({ variant, inserted, dbMs, totalMs: performance.now() - t0 });
    } catch (err) {
      return Response.json({ variant, error: String(err) }, { status: 500 });
    } finally {
      await sql.end();
    }
  },
} satisfies ExportedHandler<BenchEnv>;
