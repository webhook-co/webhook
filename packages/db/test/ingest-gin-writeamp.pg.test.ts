import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// THE DECISION, not a check.
//
// The events search ORs three trigram-GIN-indexed columns with an UNINDEXED `headers::text ilike`. Postgres
// can only bitmap-OR a disjunction when EVERY branch is index-backed, so that one branch forgoes the trigram
// path for the WHOLE search — which means the 0023 GINs are, today, paying ingest write-amp for ZERO read
// benefit on every surface. Un-poisoning it has exactly two options:
//
//   (a) add a trigram GIN on (headers::text) — every branch indexed, BitmapOr available.
//   (b) drop the headers branch on ALL FOUR surfaces — the remaining branches are indexed, BitmapOr
//       available, and the 0023 GINs finally earn their keep.
//
// (a) is better for users (header search stays) but puts a GIN on the LARGEST column, on the METERED INGEST
// HOT PATH — where `webhook_ingest` has a 5s statement_timeout (0006) and WATERMARK_DELTA_MS is DERIVED from
// that timeout. A GIN pending-list flush inside that budget is a DROPPED WEBHOOK, and a shifted latency
// distribution perturbs the gapless-tail proof. That is not a cost to discover in production.
//
// So the rule is written HERE, before the number is known:
//
//   If p99 single-insert latency regresses by more than MAX_P99_REGRESSION, or ANY single insert exceeds
//   MAX_SINGLE_INSERT_MS (a fifth of ingest's timeout), (a) is refused and (b) ships instead.
//
// Both branches are ready in the same PR; only WHICH one ships is data-dependent. That is not deferral.
const MAX_P99_REGRESSION = 1.25; // +25%
const MAX_SINGLE_INSERT_MS = 1000; // 20% of the ingest role's 5s statement_timeout
const N = 300; // enough for a p99 to mean something without making the suite slow

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
/** DDL needs the schema owner — webhook_app is least-privilege and cannot CREATE INDEX (correctly). */
let owner: Sql;
let orgId: string;
let endpointId: string;

/** A realistic captured header set: ~20 headers, ~1KB serialized — what the GIN would actually index. */
function headers(i: number): string {
  const base: [string, string][] = [
    ["content-type", "application/json"],
    ["user-agent", "Stripe/1.0 (+https://stripe.com/docs/webhooks)"],
    ["webhook-id", `msg_${randomUUID()}`],
    ["webhook-timestamp", String(1700000000 + i)],
    ["webhook-signature", `v1,${Buffer.from(randomUUID()).toString("base64")}`],
    ["x-forwarded-for", `203.0.113.${i % 255}`],
    ["x-request-id", randomUUID()],
    ["accept-encoding", "gzip, deflate, br"],
    ["cf-ray", `${randomUUID().slice(0, 16)}-LHR`],
    ["cf-ipcountry", "GB"],
  ];
  for (let k = 0; k < 10; k++) base.push([`x-custom-${k}`, `value-${randomUUID()}`]);
  return JSON.stringify(base);
}

async function insertOne(i: number): Promise<number> {
  const id = newId();
  const started = performance.now();
  await withTenant(
    app,
    orgId,
    (tx) => tx`
      insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, headers,
                          dedup_key, dedup_strategy, provider, verified)
      values (${id}, ${orgId}, ${endpointId}, ${`k/${id}`}, 1024, ${headers(i)}::jsonb,
              ${`unique:${id}`}, 'unique', 'stripe', true)`,
  );
  return performance.now() - started;
}

/** Insert N rows, return {p99, max} in ms. */
async function measure(): Promise<{ p99: number; max: number }> {
  const times: number[] = [];
  for (let i = 0; i < N; i++) times.push(await insertOne(i));
  times.sort((a, b) => a - b);
  return { p99: times[Math.floor(times.length * 0.99)]!, max: times.at(-1)! };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  orgId = (await createOrg(app, { slug: `o-${randomUUID().slice(0, 8)}`, name: "Bench" })).id;
  endpointId = (await createEndpoint(app, { orgId, name: "bench-ep" }, hasher)).id;
}, setupHookTimeoutMs());

afterAll(async () => {
  await owner?.end();
  await app?.end();
  await pg?.stop();
});

describe("GIN-on-headers ingest write-amp (the measurement that refused option (a))", () => {
  // MEASURED 2026-07-17: p99 0.69ms -> 8.80ms = 12.80x, max 9.19ms.
  //
  // The rule (written above, BEFORE the number was known) allowed 1.25x. 12.8x refuses it outright, so the
  // headers branch was DROPPED instead — see eventSearchFilter in reads.ts.
  //
  // Note `max` was 9.19ms, nowhere near the 1000ms single-insert bound: eyeballing that alone would have said
  // "harmless, ship it" and put a 12x write-amp on the metered ingest path. The p99 is the number that
  // mattered, and pre-committing the rule is what stopped the wrong read of the data.
  //
  // This test now ASSERTS THE REFUSAL, so the finding cannot rot into folklore: if a future Postgres, a
  // different GIN config, or a cheaper expression makes this affordable, it goes RED — and that is the signal
  // to revisit header-inclusive search, not a flake to silence.
  it("a trigram GIN on (headers::text) costs far more than the rule allows — which is why it is not there", async () => {
    // Warm: the first inserts pay page allocation and plan caching, which is not what we are measuring.
    for (let i = 0; i < 30; i++) await insertOne(i);

    const before = await measure();

    // `jsonb::text` must be IMMUTABLE for Postgres to index the expression. Believed yes (jsonb_out is
    // provolatile='i'), but this is the empirical check: a non-immutable expression raises 42P17 right here
    // rather than in a code review's opinion.
    await owner`create index events_headers_trgm on events using gin ((headers::text) gin_trgm_ops)
              with (fastupdate = on, gin_pending_list_limit = 1024)`;

    const after = await measure();

    const ratio = after.p99 / before.p99;

    console.log(
      `[gin-writeamp] p99 ${before.p99.toFixed(2)}ms -> ${after.p99.toFixed(2)}ms (${ratio.toFixed(2)}x), ` +
        `max ${after.max.toFixed(2)}ms | rule: p99 <= ${MAX_P99_REGRESSION}x AND max <= ${MAX_SINGLE_INSERT_MS}ms`,
    );

    // `jsonb::text` IS immutable enough to index — the CREATE INDEX above would have raised 42P17 otherwise.
    // That was an open question resolved by running it, not by opinion. The cost is what refuses it.
    expect(ratio).toBeGreaterThan(MAX_P99_REGRESSION);

    // A single insert never approached the timeout — which is exactly the trap. Only the p99 refuses this.
    expect(after.max).toBeLessThan(MAX_SINGLE_INSERT_MS);
  });
});
