import { randomUUID } from "node:crypto";

import { type AuthContext } from "@webhook-co/contract";
import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAgentTrigger,
  createAgentTriggerHandlers,
  listAgentTriggers,
  revokeAgentTrigger,
  TriggerEndpointNotFoundError,
} from "../src/agent-triggers";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// agent_triggers CRUD + the triggers.* capability handlers (S5), against a REAL Postgres under the
// non-owner webhook_app role + RLS. Proves: create binds only a live same-org endpoint, list is
// org-scoped + active-only, soft-revoke is idempotent + cross-org-safe, the scope gate + fault taxonomy,
// and (isolation red-team) that the table carries no role-targeted RLS policy and grants DML to
// webhook_app only.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let auditKey: CryptoKey;
let orgA: string;
let orgB: string;
let epA: string; // org A endpoint
let epB: string; // org B endpoint (cross-org target)

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  epB = (await createEndpoint(app, { orgId: orgB, name: "ep-b" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("createAgentTrigger", () => {
  it("registers a trigger for a live same-org endpoint (active, no name by default)", async () => {
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: epA });
    expect(t.orgId).toBe(orgA);
    expect(t.endpointId).toBe(epA);
    expect(t.name).toBeNull();
    expect(t.revokedAt).toBeNull();
    expect(t.createdAt).toBeInstanceOf(Date);
  });

  it("stores an optional name and allows MULTIPLE triggers on one endpoint", async () => {
    const a = await createAgentTrigger(app, { orgId: orgA, endpointId: epA, name: "fraud-agent" });
    const b = await createAgentTrigger(app, { orgId: orgA, endpointId: epA, name: "ops-agent" });
    expect(a.name).toBe("fraud-agent");
    expect(b.name).toBe("ops-agent");
    expect(a.id).not.toBe(b.id); // distinct rows, not an upsert
  });

  it("throws TriggerEndpointNotFoundError for a cross-org endpoint (RLS hides it)", async () => {
    await expect(createAgentTrigger(app, { orgId: orgA, endpointId: epB })).rejects.toBeInstanceOf(
      TriggerEndpointNotFoundError,
    );
  });

  it("throws TriggerEndpointNotFoundError for an unknown endpoint id", async () => {
    await expect(
      createAgentTrigger(app, { orgId: orgA, endpointId: randomUUID() }),
    ).rejects.toBeInstanceOf(TriggerEndpointNotFoundError);
  });

  it("enforces a per-org active-trigger soft cap (RATE_LIMITED)", async () => {
    const capOrg = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org cap" })).id;
    const ep = (await createEndpoint(app, { orgId: capOrg, name: "ep-cap" }, hasher)).id;
    // Fill to a small injected cap, then the next create is rejected.
    await createAgentTrigger(app, { orgId: capOrg, endpointId: ep, maxActive: 2 });
    await createAgentTrigger(app, { orgId: capOrg, endpointId: ep, maxActive: 2 });
    await expect(
      createAgentTrigger(app, { orgId: capOrg, endpointId: ep, maxActive: 2 }),
    ).rejects.toMatchObject({ name: "CapabilityFault", code: "RATE_LIMITED" });
    // Revoking one frees a slot (the cap counts only ACTIVE triggers).
    const active = await listAgentTriggers(app, capOrg, ep);
    await revokeAgentTrigger(app, capOrg, active[0]!.id);
    const t = await createAgentTrigger(app, { orgId: capOrg, endpointId: ep, maxActive: 2 });
    expect(t.revokedAt).toBeNull();
  });
});

describe("listAgentTriggers", () => {
  it("returns an org's active triggers newest-first, filterable by endpoint, org-scoped", async () => {
    const iso = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org iso" })).id;
    const ep1 = (await createEndpoint(app, { orgId: iso, name: "ep1" }, hasher)).id;
    const ep2 = (await createEndpoint(app, { orgId: iso, name: "ep2" }, hasher)).id;
    const t1 = await createAgentTrigger(app, { orgId: iso, endpointId: ep1 });
    const t2 = await createAgentTrigger(app, { orgId: iso, endpointId: ep1 });
    const t3 = await createAgentTrigger(app, { orgId: iso, endpointId: ep2 });

    const all = await listAgentTriggers(app, iso);
    expect(all.map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]); // newest first

    const onEp1 = await listAgentTriggers(app, iso, ep1);
    expect(onEp1.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(onEp1.map((t) => t.id)).not.toContain(t3.id);
  });

  it("excludes revoked triggers", async () => {
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: epA, name: "to-revoke" });
    await revokeAgentTrigger(app, orgA, t.id);
    const active = await listAgentTriggers(app, orgA, epA);
    expect(active.map((x) => x.id)).not.toContain(t.id);
  });
});

describe("revokeAgentTrigger", () => {
  it("soft-revokes an active trigger and is IDEMPOTENT (second revoke → {id} success)", async () => {
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: epA });
    const first = await revokeAgentTrigger(app, orgA, t.id);
    expect(first).toEqual({ id: t.id });
    // A second revoke of the same (now-revoked) trigger succeeds idempotently — NOT null/NOT_FOUND.
    const second = await revokeAgentTrigger(app, orgA, t.id);
    expect(second).toEqual({ id: t.id });
    // the row still exists (soft-revoke), revoked_at is set and UNCHANGED by the idempotent second call
    const [row] = await withTenant(
      app,
      orgA,
      (tx) =>
        tx<{ revoked_at: Date | null }[]>`select revoked_at from agent_triggers where id = ${t.id}`,
    );
    expect(row?.revoked_at).not.toBeNull();
  });

  it("cannot revoke another org's trigger (RLS → null, no cross-org write)", async () => {
    const bTrigger = await createAgentTrigger(app, { orgId: orgB, endpointId: epB });
    const cross = await revokeAgentTrigger(app, orgA, bTrigger.id); // org A tries to revoke org B's
    expect(cross).toBeNull();
    // org B's trigger is still active
    const stillActive = await listAgentTriggers(app, orgB, epB);
    expect(stillActive.map((t) => t.id)).toContain(bTrigger.id);
  });

  it("returns null for an unknown id", async () => {
    expect(await revokeAgentTrigger(app, orgA, randomUUID())).toBeNull();
  });
});

describe("triggers.* capability handlers", () => {
  const ctx = (scopes: string[]): AuthContext => ({ orgId: orgA, scopes });
  const h = () => createAgentTriggerHandlers({ tenant: app, auditKey });
  const create = (c: AuthContext, input: unknown) => h().get("triggers.create")!(c, input);
  const list = (c: AuthContext, input: unknown) => h().get("triggers.list")!(c, input);
  const revoke = (c: AuthContext, input: unknown) => h().get("triggers.revoke")!(c, input);

  it("mutations require triggers:write; list requires events:read (scope separation)", async () => {
    // No scopes → FORBIDDEN everywhere.
    await expect(create(ctx([]), { endpointId: epA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(list(ctx([]), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(revoke(ctx([]), { triggerId: randomUUID() })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A read-only events:read key can list but CANNOT create/revoke (the read scope stays side-effect-free).
    await expect(create(ctx(["events:read"]), { endpointId: epA })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(revoke(ctx(["events:read"]), { triggerId: randomUUID() })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A triggers:write key can create/revoke but CANNOT list (needs events:read).
    await expect(list(ctx(["triggers:write"]), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create returns the trigger; a non-uuid endpointId → VALIDATION_ERROR", async () => {
    const t = await create(ctx(["triggers:write"]), { endpointId: epA, name: "via-handler" });
    expect(t).toMatchObject({ endpointId: epA, name: "via-handler", revokedAt: null });
    await expect(
      create(ctx(["triggers:write"]), { endpointId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("create for a cross-org endpoint → NOT_FOUND (no existence leak)", async () => {
    await expect(create(ctx(["triggers:write"]), { endpointId: epB })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("revoke of an unknown/cross-org id → NOT_FOUND; a non-uuid → VALIDATION_ERROR", async () => {
    await expect(
      revoke(ctx(["triggers:write"]), { triggerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(revoke(ctx(["triggers:write"]), { triggerId: "nope" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("revoke is idempotent through the handler (second revoke → { id })", async () => {
    const created = (await create(ctx(["triggers:write"]), { endpointId: epA })) as { id: string };
    const first = await revoke(ctx(["triggers:write"]), { triggerId: created.id });
    expect(first).toEqual({ id: created.id });
    const second = await revoke(ctx(["triggers:write"]), { triggerId: created.id });
    expect(second).toEqual({ id: created.id }); // idempotent success, not NOT_FOUND
  });

  it("list returns the caller's active triggers under { items }", async () => {
    const res = (await list(ctx(["events:read"]), {})) as { items: { id: string }[] };
    expect(Array.isArray(res.items)).toBe(true);
  });
});

describe("agent_triggers RLS + grants (isolation red-team)", () => {
  it("has ONLY current_org_id() policies — none role-targeted", async () => {
    const owner = createClient(pg.ownerUrl);
    try {
      const policies = await owner<
        { polname: string; roles: string; using_expr: string | null; check_expr: string | null }[]
      >`
        select polname,
               (array(select rolname from pg_roles where oid = any(polroles)))::text as roles,
               pg_get_expr(polqual, polrelid) as using_expr,
               pg_get_expr(polwithcheck, polrelid) as check_expr
        from pg_policy where polrelid = 'agent_triggers'::regclass
        order by polname`;
      expect(policies.length).toBe(4); // select / insert / update / delete
      for (const p of policies) {
        // PUBLIC (polroles = {0}) resolves to an EMPTY role-name array literal "{}" — a role-targeted
        // policy would name a specific role here (e.g. "{webhook_reconciler}"), the cross-org read
        // pattern this test guards against.
        expect(p.roles).toBe("{}");
        const expr = `${p.using_expr ?? ""} ${p.check_expr ?? ""}`;
        expect(expr).toContain("current_org_id()");
      }
    } finally {
      await owner.end();
    }
  });

  it("grants DML on agent_triggers to webhook_app only (no cross-org role)", async () => {
    const owner = createClient(pg.ownerUrl);
    try {
      const grants = await owner<{ grantee: string }[]>`
        select distinct grantee from information_schema.role_table_grants
        where table_name = 'agent_triggers' and table_schema = 'public'`;
      const nonOwner = grants.map((g) => g.grantee).filter((g) => g !== DB_ROLES.owner);
      expect(nonOwner.sort()).toEqual([DB_ROLES.app]);
    } finally {
      await owner.end();
    }
  });
});
