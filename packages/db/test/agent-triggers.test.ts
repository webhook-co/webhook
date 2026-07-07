import { randomUUID } from "node:crypto";

import { type AuthContext } from "@webhook-co/contract";
import {
  encodeCursor,
  importAuditKey,
  importCursorKey,
  msToOrderKey,
  newId,
  type Cursor,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAgentTrigger,
  createAgentTriggerHandlers,
  listAgentTriggers,
  projectTriggerPage,
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
let cursorKey: CryptoKey;
let orgA: string;
let orgB: string;
let epA: string; // org A endpoint
let epB: string; // org B endpoint (cross-org target)

// Deterministic, far-past receive times so seeded events sit well below the gapless watermark.
const WAIT_BASE = new Date("2026-06-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(WAIT_BASE.getTime() + ms);

/** Seed an event on an endpoint with a chosen verification state, backdated below the watermark. */
async function seedEvent(
  orgId: string,
  endpointId: string,
  opts: { at: Date; state?: "verified" | "authenticated" | "failed" | "unattempted" },
): Promise<string> {
  const id = newId();
  const state = opts.state ?? "verified";
  const verified = state === "verified" || state === "authenticated";
  const verification =
    state === "verified"
      ? { ok: true }
      : state === "authenticated"
        ? { ok: true, authenticity: "token" }
        : state === "failed"
          ? { ok: false }
          : null; // unattempted
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy, verified, verification)
      values (${id}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${id}`}, ${64},
              ${newId()}, ${"content_hash"}, ${verified}, ${verification === null ? null : tx.json(verification)})`;
    await tx`update events set received_at = ${opts.at} where id = ${id}`;
  });
  return id;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
  cursorKey = await importCursorKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 3 + 1) % 256)),
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
  const h = () => createAgentTriggerHandlers({ tenant: app, auditKey, cursorKey });
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

describe("projectTriggerPage (pure — failed-drop + vouched + resume cursor)", () => {
  const c = (n: number): Cursor => ({ orderKey: msToOrderKey(at(n).getTime()), id: newId() });
  const summary = (state: "verified" | "authenticated" | "failed" | "unattempted") =>
    ({
      id: newId(),
      orgId: orgA,
      endpointId: epA,
      receivedAt: at(1),
      provider: "stripe",
      dedupKey: "d",
      dedupStrategy: "content_hash",
      verified: state === "verified" || state === "authenticated",
      verificationState: state,
    }) as const;

  it("drops failed events, stamps vouched, advances resume past EVERY scanned row", () => {
    const items = [
      { item: summary("verified"), cursor: c(1) },
      { item: summary("failed"), cursor: c(2) },
      { item: summary("unattempted"), cursor: c(3) },
    ];
    const { events, resumeCursor } = projectTriggerPage(items);
    expect(events.map((e) => e.verificationState)).toEqual(["verified", "unattempted"]); // failed gone
    expect(events.map((e) => e.vouched)).toEqual([true, false]); // verified vouched, unattempted not
    expect(resumeCursor).toEqual(items[2]!.cursor); // resume = the LAST scanned row (an unattempted here)
  });

  it("authenticated is vouched; an empty page yields no resume cursor", () => {
    const { events } = projectTriggerPage([{ item: summary("authenticated"), cursor: c(1) }]);
    expect(events[0]?.vouched).toBe(true);
    expect(projectTriggerPage([]).resumeCursor).toBeUndefined();
  });

  it("a page of ONLY failed events surfaces nothing but still advances the cursor past them", () => {
    const items = [
      { item: summary("failed"), cursor: c(1) },
      { item: summary("failed"), cursor: c(2) },
    ];
    const { events, resumeCursor } = projectTriggerPage(items);
    expect(events).toEqual([]);
    expect(resumeCursor).toEqual(items[1]!.cursor); // advanced past the trailing failed run — never re-scanned
  });
});

describe("triggers.wait handler (consumption / delivery guarantee)", () => {
  const ctx = (scopes: string[]): AuthContext => ({ orgId: orgA, scopes });
  const wait = (c: AuthContext, input: unknown) =>
    createAgentTriggerHandlers({ tenant: app, auditKey, cursorKey }).get("triggers.wait")!(
      c,
      input,
    );
  type WaitResult = {
    events: { id: string; vouched: boolean; verificationState?: string }[];
    nextCursor: string | null;
    caughtUp: boolean;
  };

  async function newTrigger(orgId: string, endpointId: string): Promise<string> {
    return (await createAgentTrigger(app, { orgId, endpointId })).id;
  }

  it("requires events:read (FORBIDDEN without it, incl. a triggers:write-only key)", async () => {
    const t = await newTrigger(orgA, epA);
    await expect(wait(ctx([]), { triggerId: t })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(wait(ctx(["triggers:write"]), { triggerId: t })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("resolves an active trigger and returns its endpoint's events oldest-first, then caughtUp", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-wait-1" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const e2 = await seedEvent(orgA, ep, { at: at(2000) });
    const t = await newTrigger(orgA, ep);
    const r = (await wait(ctx(["events:read"]), { triggerId: t })) as WaitResult;
    expect(r.events.map((e) => e.id)).toEqual([e1, e2]);
    expect(r.events.every((e) => e.vouched)).toBe(true); // seeded verified
    expect(r.caughtUp).toBe(true);
    expect(r.nextCursor).not.toBeNull();
  });

  it("NEVER surfaces failed events, advances the cursor past them, and never re-scans (limit-1 drain)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-wait-failed" }, hasher)).id;
    const good1 = await seedEvent(orgA, ep, { at: at(1000), state: "verified" });
    await seedEvent(orgA, ep, { at: at(2000), state: "failed" });
    const good2 = await seedEvent(orgA, ep, { at: at(3000), state: "unattempted" });
    const t = await newTrigger(orgA, ep);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const r = (await wait(ctx(["events:read"]), {
        triggerId: t,
        cursor,
        limit: 1,
      })) as WaitResult;
      for (const e of r.events) seen.push(e.id);
      pages += 1;
      if (r.caughtUp) break;
      cursor = r.nextCursor ?? undefined;
      expect(pages).toBeLessThan(8); // a stall on the un-returnable failed row would spin here
    }
    expect(seen).toEqual([good1, good2]); // failed never surfaced
    // vouched honesty: good1 verified → true, good2 unattempted → false
    const all = (await wait(ctx(["events:read"]), { triggerId: t })) as WaitResult;
    expect(all.events.find((e) => e.id === good1)?.vouched).toBe(true);
    expect(all.events.find((e) => e.id === good2)?.vouched).toBe(false);
  });

  it("at-least-once: re-calling with the PRIOR cursor re-delivers (crash-before-ack), never loses", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-wait-alo" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const e2 = await seedEvent(orgA, ep, { at: at(2000) });
    const t = await newTrigger(orgA, ep);
    const first = (await wait(ctx(["events:read"]), { triggerId: t, limit: 1 })) as WaitResult;
    expect(first.events.map((e) => e.id)).toEqual([e1]);
    // "crash" before persisting first.nextCursor → re-call from the SAME (undefined) start cursor
    const replay = (await wait(ctx(["events:read"]), { triggerId: t, limit: 1 })) as WaitResult;
    expect(replay.events.map((e) => e.id)).toEqual([e1]); // re-delivered, not skipped
    // acking (passing nextCursor) advances to e2
    const next = (await wait(ctx(["events:read"]), {
      triggerId: t,
      cursor: first.nextCursor,
      limit: 1,
    })) as WaitResult;
    expect(next.events.map((e) => e.id)).toEqual([e2]);
  });

  it("a revoked trigger → NOT_FOUND; a cross-org trigger → NOT_FOUND (no leak)", async () => {
    const t = await newTrigger(orgA, epA);
    await revokeAgentTrigger(app, orgA, t);
    await expect(wait(ctx(["events:read"]), { triggerId: t })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const bT = await createAgentTrigger(app, { orgId: orgB, endpointId: epB });
    await expect(wait(ctx(["events:read"]), { triggerId: bT.id })).rejects.toMatchObject({
      code: "NOT_FOUND", // org A cannot resolve org B's trigger (RLS)
    });
  });

  it("a below-window cursor RESUMES from the oldest survivor (no CURSOR_EXPIRED guard while retention is infinite); a garbage cursor → VALIDATION_ERROR", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-wait-expired" }, hasher)).id;
    const e = await seedEvent(orgA, ep, { at: at(5000) });
    const t = await newTrigger(orgA, ep);
    // A validly-signed cursor far below the endpoint's oldest event. With infinite retention nothing was
    // pruned, so this safely resumes from the oldest survivor (not an error).
    const ancient = await encodeCursor(
      { orderKey: msToOrderKey(new Date("2020-01-01T00:00:00Z").getTime()), id: newId() },
      cursorKey,
    );
    const r = (await wait(ctx(["events:read"]), { triggerId: t, cursor: ancient })) as WaitResult;
    expect(r.events.map((x) => x.id)).toEqual([e]);
    // A malformed cursor still fails fast.
    await expect(
      wait(ctx(["events:read"]), { triggerId: t, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("treats a null cursor the same as omitted (a caught-up nextCursor:null round-trips, not an error)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-wait-null-cursor" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await newTrigger(orgA, ep);
    const r = (await wait(ctx(["events:read"]), { triggerId: t, cursor: null })) as WaitResult;
    expect(r.events.map((x) => x.id)).toEqual([e1]); // null → start from oldest, NOT a VALIDATION_ERROR
  });
});

describe("triggers.wait inline body (C2 — PayloadReader attachment)", () => {
  const ctx = (scopes: string[]): AuthContext => ({ orgId: orgA, scopes });
  // A fake PayloadReader: returns a canned body for known event ids, found:false otherwise.
  type Body = {
    body: string;
    encoding: "utf8" | "base64";
    truncated: boolean;
    contentType: string | null;
  };
  function fakeReader(bodies: Record<string, Body>) {
    return {
      readBoundedBodies: async ({ eventIds }: { eventIds: readonly string[] }) =>
        eventIds.map((eventId) => {
          const b = bodies[eventId];
          return b
            ? { eventId, found: true, byteLength: b.body.length, ...b }
            : {
                eventId,
                found: false,
                body: null,
                encoding: "utf8" as const,
                byteLength: 0,
                truncated: false,
                contentType: null,
              };
        }),
    };
  }
  const waitWith = (
    reader: ReturnType<typeof fakeReader> | undefined,
    c: AuthContext,
    input: unknown,
  ) =>
    createAgentTriggerHandlers({ tenant: app, auditKey, cursorKey, payloadReader: reader }).get(
      "triggers.wait",
    )!(c, input);
  type WaitResult = {
    events: {
      id: string;
      body?: string | null;
      bodyEncoding?: string;
      bodyTruncated?: boolean;
      contentType?: string | null;
    }[];
  };

  it("attaches the bounded body (default includeBody) via the PayloadReader RPC", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-1" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    const reader = fakeReader({
      [e1]: {
        body: '{"ok":true}',
        encoding: "utf8",
        truncated: false,
        contentType: "application/json",
      },
    });
    const r = (await waitWith(reader, ctx(["events:read"]), { triggerId: t.id })) as WaitResult;
    const ev = r.events.find((e) => e.id === e1)!;
    expect(ev.body).toBe('{"ok":true}');
    expect(ev.bodyEncoding).toBe("utf8");
    expect(ev.bodyTruncated).toBe(false);
    expect(ev.contentType).toBe("application/json");
  });

  it("includeBody:false skips the RPC entirely (body null, reader NOT called)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-2" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    let called = false;
    const reader = {
      readBoundedBodies: async (a: { eventIds: readonly string[] }) => {
        called = true;
        return a.eventIds.map((eventId) => ({
          eventId,
          found: true,
          body: "x",
          encoding: "utf8" as const,
          byteLength: 1,
          truncated: false,
          contentType: null,
        }));
      },
    };
    const r = (await waitWith(reader, ctx(["events:read"]), {
      triggerId: t.id,
      includeBody: false,
    })) as WaitResult;
    expect(called).toBe(false);
    expect(r.events.find((e) => e.id === e1)!.body ?? null).toBeNull();
  });

  it("returns body:null when no PayloadReader is wired (graceful degradation)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-3" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    const r = (await waitWith(undefined, ctx(["events:read"]), { triggerId: t.id })) as WaitResult;
    expect(r.events.find((e) => e.id === e1)!.body ?? null).toBeNull();
  });

  it("sets body:null for an event the reader reports found:false (no oracle)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-4" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    const r = (await waitWith(fakeReader({}), ctx(["events:read"]), {
      triggerId: t.id,
    })) as WaitResult;
    const ev = r.events.find((e) => e.id === e1)!;
    expect(ev.body ?? null).toBeNull();
    expect(ev.bodyTruncated).toBe(false);
  });

  it("forwards maxBodyBytes as maxBytesEach and the caller's orgId to the RPC (default = 64 KiB)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-cap" }, hasher)).id;
    await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    // A spy reader capturing exactly what the handler passes down (orgId must be the pinned ctx principal).
    const seen: { orgId: string; maxBytesEach: number }[] = [];
    const spy = {
      readBoundedBodies: async (a: {
        orgId: string;
        eventIds: readonly string[];
        maxBytesEach: number;
      }) => {
        seen.push({ orgId: a.orgId, maxBytesEach: a.maxBytesEach });
        return a.eventIds.map((eventId) => ({
          eventId,
          found: false,
          body: null,
          encoding: "utf8" as const,
          byteLength: 0,
          truncated: false,
          contentType: null,
        }));
      },
    };
    await waitWith(spy, ctx(["events:read"]), { triggerId: t.id, maxBodyBytes: 512 });
    await waitWith(spy, ctx(["events:read"]), { triggerId: t.id }); // omitted → server default
    expect(seen).toEqual([
      { orgId: orgA, maxBytesEach: 512 },
      { orgId: orgA, maxBytesEach: 65536 },
    ]);
  });

  it("degrades to summary-only (body null) when the PayloadReader RPC THROWS — never fails the poll", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-5" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    // A transient engine/R2 hiccup makes the RPC throw. The tail read already succeeded, so the poll MUST
    // still return its events (body absent) — else the agent can't advance its ack cursor and the loop stalls.
    const throwingReader = {
      readBoundedBodies: async () => {
        throw new Error("transient engine/R2 failure");
      },
    };
    const r = (await waitWith(throwingReader, ctx(["events:read"]), {
      triggerId: t.id,
    })) as WaitResult;
    const ev = r.events.find((e) => e.id === e1)!;
    expect(ev.body ?? null).toBeNull();
    expect(ev.bodyEncoding).toBe("utf8");
    expect(ev.contentType ?? null).toBeNull();
    expect(ev.bodyTruncated).toBe(false);
  });

  it("a body-absent event carries the SAME keys as a found event (no field flicker within a page)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-body-6" }, hasher)).id;
    const e1 = await seedEvent(orgA, ep, { at: at(1000) });
    const t = await createAgentTrigger(app, { orgId: orgA, endpointId: ep });
    // found:false → the event still gets body/bodyEncoding/bodyTruncated/contentType keys (nulled), exactly
    // like a found event, so a consumer never sees a key present on some page events and absent on others.
    const r = (await waitWith(fakeReader({}), ctx(["events:read"]), {
      triggerId: t.id,
    })) as WaitResult;
    const ev = r.events.find((e) => e.id === e1)!;
    expect(Object.keys(ev)).toEqual(
      expect.arrayContaining(["body", "bodyEncoding", "bodyTruncated", "contentType"]),
    );
    expect(ev.bodyEncoding).toBe("utf8");
    expect(ev.contentType).toBeNull();
  });
});
