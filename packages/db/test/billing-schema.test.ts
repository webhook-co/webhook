import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// S4.4a billing schema constraints — the security-relevant ones (the RLS isolation is covered by rls.test).
// Focus: the stripe_meter_reports outbox's GENERATED identifier (the cross-tenant metering-sabotage guard)
// + the status CHECK + the (org_id, day) PK. All under the org's RLS as webhook_app.

let pg: EphemeralPostgres;
let app: Sql;

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("stripe_meter_reports outbox constraints", () => {
  it("ACCEPTS an identifier that matches the row's own {org_id}:{day}", async () => {
    const orgId = await seedOrg();
    const day = "2026-07-15";
    const ownId = `${orgId}:${day}`;
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ identifier: string }[]>`
        insert into stripe_meter_reports (org_id, day, event_count, identifier)
        values (${orgId}, ${day}, ${100}, ${ownId}) returning identifier`,
    );
    expect(row.identifier).toBe(ownId);
  });

  it("REJECTS a spoofed identifier bound to ANOTHER org (the CHECK closes the cross-tenant claim)", async () => {
    const orgId = await seedOrg();
    const day = "2026-07-16";
    const spoofed = `${randomUUID()}:${day}`; // another org's {org}:{day}
    // Under org A's own RLS context, try to pre-claim org B's outbox key — the CHECK (identifier =
    // org_id::text || ':' || day::text) binds it to org A's own row, so this is rejected.
    await expect(
      withTenant(
        app,
        orgId,
        (tx) => tx`
          insert into stripe_meter_reports (org_id, day, event_count, identifier)
          values (${orgId}, ${day}, ${1}, ${spoofed})`,
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("enforces the (org_id, day) primary key — one outbox row per org per day", async () => {
    const orgId = await seedOrg();
    const day = "2026-07-17";
    const id = `${orgId}:${day}`;
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into stripe_meter_reports (org_id, day, event_count, identifier) values (${orgId}, ${day}, ${1}, ${id})`,
    );
    await expect(
      withTenant(
        app,
        orgId,
        (tx) =>
          tx`insert into stripe_meter_reports (org_id, day, event_count, identifier) values (${orgId}, ${day}, ${2}, ${id})`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("enforces the status CHECK (pending|sending|sent) — no arbitrary state", async () => {
    const orgId = await seedOrg();
    const badId = `${orgId}:2026-07-18`;
    await expect(
      withTenant(
        app,
        orgId,
        (tx) => tx`
          insert into stripe_meter_reports (org_id, day, event_count, identifier, status)
          values (${orgId}, ${"2026-07-18"}, ${1}, ${badId}, ${"exploded"})`,
      ),
    ).rejects.toThrow(/check constraint|violates/i);
    // The valid states are accepted.
    const okId = `${orgId}:2026-07-19`;
    const [ok] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ status: string }[]>`
        insert into stripe_meter_reports (org_id, day, event_count, identifier, status)
        values (${orgId}, ${"2026-07-19"}, ${1}, ${okId}, ${"sending"}) returning status`,
    );
    expect(ok.status).toBe("sending");
  });
});
