import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ORG_SLUG_RESERVED, validateOrgSlug } from "@webhook-co/shared";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES, TENANT_GUC } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The slug rules exist TWICE — as the DB `orgs_slug_format` CHECK + `org_slug_reserved()` function (migration
// 0069), and as `validateOrgSlug`/`ORG_SLUG_RESERVED` in @webhook-co/shared. Two copies drift. This is the
// guard that they don't: it runs the TS list and a battery of format cases through the REAL database and
// asserts the two authorities agree on every one.

let pg: EphemeralPostgres;
let owner: Sql;
let app: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }), { max: 2 });
  // webhook_app is the role that actually inserts orgs in production, so the format arm exercises the CHECK
  // through it (under the same RLS context a real create uses).
  app = createClient(pg.urlFor({ role: DB_ROLES.app }), { max: 2 });
}, setupHookTimeoutMs());

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => {});
  await app?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop();
});

/** Thrown to abort a probe transaction once the insert has PASSED every CHECK, so nothing persists. */
class Accepted extends Error {}

/**
 * Does the REAL database accept this slug? Attempt an actual `insert into orgs` under a fresh tenant context
 * and roll it back either way. This runs the genuine `orgs_slug_format` + `orgs_slug_not_reserved` CHECKs — NOT
 * a hand-copied reproduction of their regex, which would agree with a stale TS validator and let a format drift
 * ship green (the a-guard's-tests-must-run-the-guard trap). A rejection surfaces as SQLSTATE 23514.
 */
async function dbAcceptsSlug(slug: string): Promise<boolean> {
  const id = randomUUID();
  try {
    await app.begin(async (tx) => {
      await tx`select set_config(${TENANT_GUC}, ${id}, true)`;
      await tx`
        insert into orgs (id, slug, name, region, retention_days)
        values (${id}, ${slug}::citext, ${"Parity"}, ${"us"}, ${7})`;
      throw new Accepted();
    });
    return false; // unreachable: the callback always throws (Accepted on success, the DB error otherwise)
  } catch (error) {
    if (error instanceof Accepted) return true;
    if ((error as { code?: string }).code === "23514") return false; // check_violation
    throw error;
  }
}

describe("the TS slug rules match the database exactly", () => {
  it("every word ORG_SLUG_RESERVED holds is reserved in the DB too", async () => {
    const notReserved: string[] = [];
    for (const w of ORG_SLUG_RESERVED) {
      const [{ reserved }] = await owner<{ reserved: boolean }[]>`
        select org_slug_reserved(${w}::citext) as reserved`;
      if (!reserved) notReserved.push(w);
    }
    expect(notReserved, "words the TS list claims are reserved but the DB does not").toEqual([]);
  });

  it("the DB reserves NOTHING the TS list has forgotten — the sets are equal", async () => {
    // Pull the reserved words straight out of the function body (it's an IMMUTABLE `s in (...)`), so a word
    // added to the SQL but not to the TS list is caught.
    const [{ def }] = await owner<{ def: string }[]>`
      select pg_get_functiondef('org_slug_reserved(citext)'::regprocedure) as def`;
    const inDb = new Set([...def!.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]!));
    const missingFromTs = [...inDb].filter((w) => !ORG_SLUG_RESERVED.has(w));
    expect(missingFromTs, "words the DB reserves but the TS list has not").toEqual([]);
  });

  it("agrees with the DB CHECK on a battery of format cases — via a REAL insert, not a copy of the regex", async () => {
    const cases = [
      "acme",
      "acme-corp",
      "a".repeat(40),
      "ab", // too short
      "a".repeat(41), // too long
      "-lead",
      "trail-",
      "Has-Caps",
      "under_score",
      "12345", // all-numeric
      "a-b", // 3, valid
      "settings", // reserved — the insert path enforces that CHECK too
    ];
    for (const slug of cases) {
      const tsOk = validateOrgSlug(slug).ok;
      const dbOk = await dbAcceptsSlug(slug);
      expect(tsOk, `${slug}: TS=${tsOk} DB=${dbOk}`).toBe(dbOk);
    }
  });
});
