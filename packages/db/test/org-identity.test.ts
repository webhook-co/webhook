import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { readOrgIdentity } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// readOrgIdentity — the {id, slug, name} read the org-visibility lane threads into the /token response,
// /v1/whoami, MCP whoami, and Connected Apps. It reads exactly the ONE org named, under that org's own RLS
// context (orgs is FORCE-RLS gated on id = current_org_id()). No SECURITY DEFINER, no cross-org read.

let pg: EphemeralPostgres;
let app: Sql;

async function seedOrg(id: string, slug: string, name: string): Promise<void> {
  await withTenant(
    app,
    id,
    (tx) => tx`insert into orgs (id, slug, name) values (${id}, ${slug}, ${name})`,
  );
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("readOrgIdentity", () => {
  it("returns {id, slug, name} for an existing org", async () => {
    const id = randomUUID();
    const slug = `acme-${id.slice(0, 8)}`;
    await seedOrg(id, slug, "Acme Inc");

    expect(await readOrgIdentity(app, id)).toEqual({ id, slug, name: "Acme Inc" });
  });

  it("yields the slug as a plain string (citext deserialization is not left to chance)", async () => {
    // slug is citext; the pool runs fetch_types:false, so an un-cast citext can come back oddly. The helper
    // casts slug::text so callers (CLI profile metadata, wire schemas) always see a plain lowercase string.
    const id = randomUUID();
    const slug = `mixed-${id.slice(0, 8)}`;
    await seedOrg(id, slug, "Mixed");

    const identity = await readOrgIdentity(app, id);
    expect(typeof identity?.slug).toBe("string");
    expect(identity?.slug).toBe(slug);
  });

  it("returns null for an id that names no org (fails closed, no throw)", async () => {
    expect(await readOrgIdentity(app, randomUUID())).toBeNull();
  });

  it("reads ONLY the org named — never bleeds a different org's identity", async () => {
    // Two distinct orgs exist. Asking for A returns A; asking for B returns B. RLS pins each read to its own
    // org context, so there is no query shape that could return the other org's row.
    const a = randomUUID();
    const b = randomUUID();
    await seedOrg(a, `a-${a.slice(0, 8)}`, "Org A");
    await seedOrg(b, `b-${b.slice(0, 8)}`, "Org B");

    expect((await readOrgIdentity(app, a))?.name).toBe("Org A");
    expect((await readOrgIdentity(app, b))?.name).toBe("Org B");
  });
});
