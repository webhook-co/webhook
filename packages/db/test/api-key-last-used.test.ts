import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LAST_USED_THROTTLE_SECONDS,
  makeApiKeyColdLookup,
  makeApiKeyLastUsedStamper,
} from "../src/api-keys";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The best-effort `api_keys.last_used_at` stamp on the verify COLD path (migration 0072). Runs against a REAL
// Postgres with the REAL webhook_authn role. The stamper is a SELF-CONTAINED, post-response task: it opens its
// OWN connection (from the authn connection string) so it never depends on the request's authn client, which
// the surface handler tears down in its `finally` before the deferred task runs. If either the column-scoped
// UPDATE grant or the role-scoped policy (0072) were missing, the stamp would be `permission denied`, swallowed
// — so the "stamps ... proving the grant works" test IS the proof the grant works.

const PREFIX = "whk";

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — seed keys + read/set last_used_at for assertions
let authn: Sql; // webhook_authn — the cold lookup's SELECT
let owner: Sql; // webhook_owner — grant/revoke for the best-effort (write-denied) case
let authnUrl: string; // the connection string the stamper opens its OWN connection from
let orgId: string;

/** A pending-promise sink standing in for `ctx.waitUntil`, so a test can deterministically await the stamp. */
const pending: Promise<unknown>[] = [];
const waitUntil = (p: Promise<unknown>): void => {
  pending.push(p);
};
const drain = async (): Promise<void> => {
  await Promise.all(pending.splice(0));
};

function mintKeyHash(): { keyHash: Buffer; start: string } {
  const secret = randomBytes(32);
  const plaintext = `${PREFIX}_${secret.toString("base64url")}`;
  return {
    keyHash: createHash("sha256").update(plaintext).digest(),
    start: plaintext.slice(0, 11),
  };
}

async function seedKey(opts: { revoked?: boolean } = {}): Promise<{ id: string; keyHash: Buffer }> {
  const { keyHash, start } = mintKeyHash();
  const id = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, revoked_at)
      values (${id}, ${orgId}, ${keyHash}, ${PREFIX}, ${start}, ${"k"}, ${tx.json(["events:read"])},
              ${opts.revoked ? tx`now()` : null})`;
  });
  return { id, keyHash };
}

async function readLastUsed(id: string): Promise<Date | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ last_used_at: Date | null }[]>`
      select last_used_at from api_keys where id = ${id}`;
    return row?.last_used_at ?? null;
  });
}

async function setLastUsed(id: string, when: "now" | "2h_ago"): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    const expr = when === "now" ? tx`now()` : tx`now() - interval '2 hours'`;
    await tx`update api_keys set last_used_at = ${expr} where id = ${id}`;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  authnUrl = pg.urlFor({ role: DB_ROLES.authn });
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  authn = createClient(authnUrl);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"Org"})`;
  });
}, setupHookTimeoutMs());

afterEach(() => {
  pending.length = 0;
});

afterAll(async () => {
  await app?.end();
  await authn?.end();
  await owner?.end();
  await pg?.stop();
});

describe("makeApiKeyLastUsedStamper — the self-contained, post-response stamp task", () => {
  it("opens its OWN connection and stamps last_used_at (and proves the webhook_authn grant works)", async () => {
    const { id } = await seedKey();
    expect(await readLastUsed(id)).toBeNull();

    const stamp = makeApiKeyLastUsedStamper({ connectionString: authnUrl, waitUntil });
    stamp(id);
    expect(pending).toHaveLength(1); // deferred, not run inline

    await drain();
    const stamped = await readLastUsed(id);
    expect(stamped).not.toBeNull(); // the authn-role UPDATE succeeded → the grant + policy are correct
    expect(Date.now() - stamped!.getTime()).toBeLessThan(60_000);
  });

  it("does NOT re-stamp within the throttle window (a hot key is written at most once per window)", async () => {
    const { id } = await seedKey();
    await setLastUsed(id, "now");
    const before = await readLastUsed(id);

    const stamp = makeApiKeyLastUsedStamper({
      connectionString: authnUrl,
      waitUntil,
      throttleSeconds: 3600,
    });
    stamp(id);
    await drain();

    expect((await readLastUsed(id))!.getTime()).toBe(before!.getTime()); // unchanged, to the microsecond
  });

  it("re-stamps once the last use is older than the window", async () => {
    const { id } = await seedKey();
    await setLastUsed(id, "2h_ago");
    const before = await readLastUsed(id);

    const stamp = makeApiKeyLastUsedStamper({
      connectionString: authnUrl,
      waitUntil,
      throttleSeconds: 3600,
    });
    stamp(id);
    await drain();

    const after = await readLastUsed(id);
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    expect(Date.now() - after!.getTime()).toBeLessThan(60_000);
  });

  it("is BEST-EFFORT — a DENIED write is swallowed and the task never rejects (auth is unaffected)", async () => {
    const { id } = await seedKey();
    // Simulate the write being rejected (as if the grant were rolled back). DB_ROLES.authn is a trusted
    // constant (a role name can't be a bind parameter, so `.unsafe`).
    await owner.unsafe(`revoke update (last_used_at) on api_keys from ${DB_ROLES.authn}`);
    try {
      const stamp = makeApiKeyLastUsedStamper({ connectionString: authnUrl, waitUntil });
      stamp(id);
      await expect(Promise.all(pending.splice(0))).resolves.toBeDefined(); // swallowed — awaiting never throws
      expect(await readLastUsed(id)).toBeNull();
    } finally {
      await owner.unsafe(`grant update (last_used_at) on api_keys to ${DB_ROLES.authn}`);
    }
  });

  it("defaults the throttle window to 15 minutes", () => {
    expect(LAST_USED_THROTTLE_SECONDS).toBe(900);
  });
});

describe("makeApiKeyColdLookup — invokes the stamper only for a valid key, never lets it fail auth", () => {
  it("calls stampLastUsed with the key id when a valid key resolves", async () => {
    const { id, keyHash } = await seedKey();
    const stamped: string[] = [];

    const coldLookup = makeApiKeyColdLookup(authn, { stampLastUsed: (kid) => stamped.push(kid) });
    const principal = await coldLookup(keyHash);

    expect(principal?.keyId).toBe(id);
    expect(stamped).toEqual([id]); // stamped its OWN key's id, discovered from the hash
  });

  it("does NOT call stampLastUsed for a REVOKED key — a dead key's use is not recorded", async () => {
    const { keyHash } = await seedKey({ revoked: true });
    const stamped: string[] = [];

    const coldLookup = makeApiKeyColdLookup(authn, { stampLastUsed: (kid) => stamped.push(kid) });
    expect(await coldLookup(keyHash)).toBeNull(); // revoked → no resolution
    expect(stamped).toHaveLength(0); // and no stamp
  });

  it("SWALLOWS a throwing stamp sink — a valid key still authenticates (telemetry can't fail auth)", async () => {
    const { id, keyHash } = await seedKey();
    // Simulate ctx.waitUntil refusing new deferred work: the sink throws synchronously.
    const coldLookup = makeApiKeyColdLookup(authn, {
      stampLastUsed: () => {
        throw new Error("waitUntil refused");
      },
    });

    const principal = await coldLookup(keyHash); // must NOT throw
    expect(principal?.keyId).toBe(id);
  });

  it("is a no-op without a stamper — resolution unaffected and the column stays untouched", async () => {
    const { id, keyHash } = await seedKey();

    const coldLookup = makeApiKeyColdLookup(authn); // no opts (tests / ingest resolver)
    const principal = await coldLookup(keyHash);

    expect(principal?.keyId).toBe(id);
    expect(await readLastUsed(id)).toBeNull();
  });
});
