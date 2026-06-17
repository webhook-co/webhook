import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
// ingest_event() always returns exactly one (event_id, inserted) row. A fake that returns an empty
// result stands in for an impossible-by-contract garble — insertIngestEvent must FAIL LOUD on it,
// never report inserted=false (which would ACK 200 for an event that was never persisted).
const emptyResultSql = (() => Promise.resolve([])) as unknown as Sql;
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { insertIngestEvent, type IngestEventInput } from "../src/ingest-event";
import { createOrg } from "../src/orgs";
import { getEvent } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// insertIngestEvent is the PRODUCTION ingest write — the wbhk.my path's `SELECT ingest_event(...)`
// run as the dedicated webhook_ingest role (statement_timeout=5s, INSERT+SELECT on events only,
// non-owner, RLS-enforced). Exercised against a REAL Postgres with the REAL role so the full
// 13-arg call (content_hash bytea, headers jsonb, provider, provider_event_id, dedup_bucket) and
// the ON CONFLICT dedup no-op are validated end-to-end, not just the bench's 7-arg shape.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — seed org/endpoint + read the stored row back
let ingest: Sql; // webhook_ingest — the production ingest write role
let orgId: string;
let endpointId: string;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  ingest = createClient(pg.urlFor({ role: DB_ROLES.ingest }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Ingest Org" })).id;
  endpointId = (await createEndpoint(app, { orgId, name: "ingest-ep" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await ingest?.end();
  await pg?.stop();
});

function row(over: Partial<IngestEventInput> = {}): IngestEventInput {
  return {
    id: randomUUID(),
    orgId,
    endpointId,
    payloadR2Key: `org/${orgId}/ep/${endpointId}/${randomUUID()}`,
    payloadBytes: 42,
    dedupKey: `stripe:${randomUUID()}`,
    dedupStrategy: "provider_event_id",
    contentType: "application/json",
    contentHash: new Uint8Array([1, 2, 3, 4]),
    headers: [
      ["content-type", "application/json"],
      ["stripe-signature", "t=1,v1=abc"],
    ],
    provider: "stripe",
    providerEventId: "evt_123",
    dedupBucket: null,
    verified: false,
    verification: null,
    ...over,
  };
}

describe("insertIngestEvent (webhook_ingest, full capture row)", () => {
  it("inserts a full event and reports inserted=true; the stored row round-trips every field", async () => {
    const r = row();
    const result = await insertIngestEvent(ingest, r);
    expect(result.inserted).toBe(true);

    const [stored] = await withTenant(app, orgId, async (tx) => {
      return tx<
        {
          id: string;
          provider: string | null;
          provider_event_id: string | null;
          dedup_strategy: string;
          content_hash: Buffer | null;
          headers: unknown;
          verified: boolean;
        }[]
      >`select id, provider, provider_event_id, dedup_strategy, content_hash, headers, verified
        from events where id = ${r.id}`;
    });
    expect(stored?.id).toBe(r.id);
    expect(stored?.provider).toBe("stripe");
    expect(stored?.provider_event_id).toBe("evt_123");
    expect(stored?.dedup_strategy).toBe("provider_event_id");
    expect(stored?.content_hash && [...stored.content_hash]).toEqual([1, 2, 3, 4]);
    // headers is jsonb; this client (fetch_types:false) surfaces it as text — typed reads are
    // Slice 8's concern. What matters here is the stored shape round-trips intact.
    const storedHeaders =
      typeof stored?.headers === "string" ? JSON.parse(stored.headers) : stored?.headers;
    expect(storedHeaders).toEqual([
      ["content-type", "application/json"],
      ["stripe-signature", "t=1,v1=abc"],
    ]);
    // Capture is the floor: events land verified=false, verifiable retroactively.
    expect(stored?.verified).toBe(false);
  });

  it("a duplicate (endpoint_id, dedup_key) is the dedup no-op: inserted=false, still one row", async () => {
    const dedupKey = `content_hash:${randomUUID()}`;
    const first = await insertIngestEvent(ingest, row({ dedupKey }));
    const second = await insertIngestEvent(ingest, row({ dedupKey }));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const rows = await withTenant(app, orgId, async (tx) => {
      return tx`select id from events where endpoint_id = ${endpointId} and dedup_key = ${dedupKey}`;
    });
    expect(rows.length).toBe(1);
  });

  it("persists a content_hash-strategy row with a null provider and a dedup_bucket", async () => {
    const r = row({
      dedupStrategy: "content_hash",
      provider: null,
      providerEventId: null,
      dedupBucket: 20_265,
      contentType: null,
      contentHash: null, // also exercises the null-bytea branch
      headers: [],
    });
    const result = await insertIngestEvent(ingest, r);
    expect(result.inserted).toBe(true);

    const [stored] = await withTenant(app, orgId, async (tx) => {
      return tx<
        {
          provider: string | null;
          dedup_bucket: string | number | null;
          content_type: string | null;
          content_hash: Buffer | null;
        }[]
      >`select provider, dedup_bucket, content_type, content_hash from events where id = ${r.id}`;
    });
    expect(stored?.provider).toBeNull();
    expect(Number(stored?.dedup_bucket)).toBe(20_265);
    expect(stored?.content_type).toBeNull();
    expect(stored?.content_hash).toBeNull();
  });

  it("throws (does NOT report a phantom inserted=false) if ingest_event returns no row", async () => {
    await expect(insertIngestEvent(emptyResultSql, row())).rejects.toThrow();
  });

  it("persists the verification outcome (verified=true + the diagnostic jsonb)", async () => {
    const verification = { ok: true, keyId: "secret_0", scheme: "stripe" };
    const r = row({ verified: true, verification });
    await insertIngestEvent(ingest, r);

    const [stored] = await withTenant(app, orgId, async (tx) => {
      return tx<{ verified: boolean; verification: unknown }[]>`
        select verified, verification from events where id = ${r.id}`;
    });
    expect(stored?.verified).toBe(true);
    const v =
      typeof stored?.verification === "string"
        ? JSON.parse(stored.verification)
        : stored?.verification;
    expect(v).toEqual(verification);
  });

  it("round-trips through getEvent: ingest-written headers read back as an array, not a string", async () => {
    const r = row({
      headers: [
        ["x-test", "1"],
        ["content-type", "application/json"],
      ],
    });
    await insertIngestEvent(ingest, r);

    // Storage-shape guard: the jsonb column must hold an ARRAY, never a JSON.stringify-then-cast
    // double-encoded STRING (the bug that 500'd events.get over Hyperdrive in prod).
    const [shape] = await withTenant(app, orgId, async (tx) => {
      return tx<{ t: string }[]>`select jsonb_typeof(headers) as t from events where id = ${r.id}`;
    });
    expect(shape?.t).toBe("array");

    // Read contract: getEvent runs EventSchema.parse — the exact path that threw when headers came
    // back as a string. Closes the missing insert→read round-trip (reads.test seeds rows manually).
    const ev = await withTenant(app, orgId, (tx) => getEvent(tx, r.id));
    expect(ev?.headers).toEqual([
      ["x-test", "1"],
      ["content-type", "application/json"],
    ]);
  });

  it("round-trips through getEvent: a non-null verification reads back as an object, not a string", async () => {
    // The sibling of the headers fix: verification is the OTHER jsonb param. Without sql.json it
    // double-encodes to a jsonb string and getEvent's EventSchema.parse (verification is
    // VerificationResultSchema.nullable()) would throw `expected object, received string`. The
    // pre-existing raw-column test (above) parses the string back and would NOT catch a regression;
    // this getEvent round-trip does.
    const verification = { ok: true, keyId: "secret_0", scheme: "stripe" } as const;
    const r = row({ verified: true, verification });
    await insertIngestEvent(ingest, r);

    const [shape] = await withTenant(app, orgId, async (tx) => {
      return tx<
        { t: string }[]
      >`select jsonb_typeof(verification) as t from events where id = ${r.id}`;
    });
    expect(shape?.t).toBe("object");

    const ev = await withTenant(app, orgId, (tx) => getEvent(tx, r.id));
    expect(ev?.verification).toEqual(verification);
  });

  it("normalizes an undefined verification to SQL NULL instead of throwing on sql.json(undefined)", async () => {
    // verification is typed `unknown`; sql.json(undefined) throws postgres.js UNDEFINED_VALUE. The
    // `?? null` normalize means a row that leaves verification undefined stores SQL NULL, not a 500.
    const r = row({ verification: undefined });
    await expect(insertIngestEvent(ingest, r)).resolves.toEqual({ inserted: true });

    const [stored] = await withTenant(app, orgId, async (tx) => {
      return tx<{ v: unknown }[]>`select verification as v from events where id = ${r.id}`;
    });
    expect(stored?.v).toBeNull();
  });
});
