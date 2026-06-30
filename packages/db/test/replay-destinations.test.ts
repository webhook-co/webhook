import { randomUUID } from "node:crypto";

import type { AuthContext } from "@webhook-co/contract";
import { importAuditKey, LocalKmsProvider, SecretStore } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createOrg } from "../src/orgs";
import {
  createReplayDestination,
  createReplayDestinationHandlers,
  listReplayDestinations,
  softDeleteReplayDestination,
} from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The replay-destination allowlist (ADR-0081), exercised against a REAL Postgres with the REAL roles:
// the org-scoped create/list/soft-delete, the idempotent live-url guard, soft-delete re-add, the in-tx
// audit row, and tenant isolation under RLS.

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — all mutations run as this role under the org's RLS context
let sealer: SecretStore; // local KMS — seals the destination signing secrets minted at create/rotate
let orgA: string;
let orgB: string;

const URL_A = "https://hooks.example.com/in";

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  sealer = new SecretStore(await LocalKmsProvider.generate());
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("createReplayDestination + listReplayDestinations", () => {
  it("registers a destination (active) and lists it under the org's RLS context", async () => {
    const d = await createReplayDestination(app, {
      orgId: orgA,
      url: URL_A,
      label: "prod receiver",
      lastValidatedAt: new Date(),
    });
    expect(d.status).toBe("active");
    expect(d.url).toBe(URL_A);
    expect(d.label).toBe("prod receiver");
    expect(d.lastValidatedAt).toBeInstanceOf(Date);

    const list = await listReplayDestinations(app, orgA);
    expect(list.map((x) => x.id)).toContain(d.id);
  });

  it("is idempotent on the live (org, url): a re-add returns the SAME row, no duplicate", async () => {
    const url = `https://idem.example.com/${randomUUID()}`;
    const first = await createReplayDestination(app, { orgId: orgA, url });
    const again = await createReplayDestination(app, { orgId: orgA, url, label: "ignored" });
    expect(again.id).toBe(first.id);
    const matches = (await listReplayDestinations(app, orgA)).filter((x) => x.url === url);
    expect(matches).toHaveLength(1);
  });

  it("writes an in-tx audit row when an audit key is supplied", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(7));
    const url = `https://audited.example.com/${randomUUID()}`;
    const d = await createReplayDestination(app, { orgId: orgA, url }, { auditKey, actor: null });
    const rows = await withTenant(app, orgA, async (tx) => {
      return tx<{ action: string; target: string }[]>`
        select action, target from audit_log
        where org_id = ${orgA} and action = 'replay_destination.added' and target = ${d.id}`;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("softDeleteReplayDestination", () => {
  it("removes a live destination (drops from list) and returns its delete time", async () => {
    const url = `https://del.example.com/${randomUUID()}`;
    const d = await createReplayDestination(app, { orgId: orgA, url });
    const removed = await softDeleteReplayDestination(app, orgA, d.id);
    expect(removed?.id).toBe(d.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);
    expect((await listReplayDestinations(app, orgA)).map((x) => x.id)).not.toContain(d.id);
  });

  it("frees the live-url guard: the same URL can be re-added as a NEW row after delete", async () => {
    const url = `https://readd.example.com/${randomUUID()}`;
    const first = await createReplayDestination(app, { orgId: orgA, url });
    await softDeleteReplayDestination(app, orgA, first.id);
    const second = await createReplayDestination(app, { orgId: orgA, url });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
  });

  it("returns null for an unknown id and for an already-removed destination (no-op)", async () => {
    expect(await softDeleteReplayDestination(app, orgA, randomUUID())).toBeNull();
    const d = await createReplayDestination(app, {
      orgId: orgA,
      url: `https://once.example.com/${randomUUID()}`,
    });
    expect(await softDeleteReplayDestination(app, orgA, d.id)).not.toBeNull();
    expect(await softDeleteReplayDestination(app, orgA, d.id)).toBeNull();
  });
});

describe("tenant isolation (RLS)", () => {
  it("org A cannot see or soft-delete org B's destination", async () => {
    const dB = await createReplayDestination(app, {
      orgId: orgB,
      url: `https://borg.example.com/${randomUUID()}`,
    });
    // Invisible to org A's list, and a cross-org delete matches zero rows → null (B's stays live).
    expect((await listReplayDestinations(app, orgA)).map((x) => x.id)).not.toContain(dB.id);
    expect(await softDeleteReplayDestination(app, orgA, dB.id)).toBeNull();
    expect((await listReplayDestinations(app, orgB)).map((x) => x.id)).toContain(dB.id);
  });
});

describe("createReplayDestinationHandlers (capability handlers)", () => {
  const ctx = (scopes: string[]): AuthContext => ({ orgId: orgA, scopes });

  it("create canonicalizes the URL before storing (host lowercased, default port stripped)", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const handlers = createReplayDestinationHandlers({ tenant: app, auditKey, sealer });
    const create = handlers.get("replayDestinations.create")!;
    const out = (await create(ctx(["endpoints:write"]), {
      url: "https://API.Example.com:443/IN",
    })) as { url: string; status: string };
    expect(out.url).toBe("https://api.example.com/IN"); // host lowercased, :443 dropped, path case kept
    expect(out.status).toBe("active");
  });

  it("enforces scope (FORBIDDEN) and rejects an SSRF-unsafe URL (VALIDATION_ERROR)", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const handlers = createReplayDestinationHandlers({ tenant: app, auditKey, sealer });
    const create = handlers.get("replayDestinations.create")!;
    await expect(
      create(ctx(["endpoints:read"]), { url: "https://ok.example.com/in" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      create(ctx(["endpoints:write"]), { url: "https://169.254.169.254/in" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("delete maps an unknown id to NOT_FOUND", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const handlers = createReplayDestinationHandlers({ tenant: app, auditKey, sealer });
    const del = handlers.get("replayDestinations.delete")!;
    await expect(
      del(ctx(["endpoints:write"]), { destinationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("create reveals a one-time signing secret; rotate reveals a fresh one; list shows metadata", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const handlers = createReplayDestinationHandlers({ tenant: app, auditKey, sealer });
    const create = handlers.get("replayDestinations.create")!;
    const rotate = handlers.get("replayDestinations.rotateSigningSecret")!;
    const list = handlers.get("replayDestinations.listSigningSecrets")!;

    const created = (await create(ctx(["endpoints:write"]), {
      url: `https://signed.example.com/${randomUUID()}`,
    })) as { id: string; signingSecret?: string };
    expect(created.signingSecret).toBeDefined();
    expect(created.signingSecret!.startsWith("whsec_")).toBe(true);

    // rotate reveals a DIFFERENT secret; the overlap is bounded to {active, retiring}
    const rotated = (await rotate(ctx(["endpoints:write"]), { destinationId: created.id })) as {
      destinationId: string;
      keyId: string;
      signingSecret: string;
    };
    expect(rotated.signingSecret).not.toBe(created.signingSecret);
    expect(rotated.signingSecret.startsWith("whsec_")).toBe(true);

    const listed = (await list(ctx(["endpoints:read"]), { destinationId: created.id })) as {
      items: { id: string; status: string }[];
    };
    expect(listed.items).toHaveLength(2); // active + retiring
    // metadata only — the plaintext never appears in the listing
    expect(JSON.stringify(listed.items)).not.toContain("whsec_");

    // unknown / cross-org destination → NOT_FOUND on both (no existence leak)
    await expect(
      rotate(ctx(["endpoints:write"]), { destinationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      list(ctx(["endpoints:read"]), { destinationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
