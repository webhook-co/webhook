import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  bumpPendingEmailChangeAttempts,
  commitEmailChange,
  countLoginMethods,
  deleteAllUserSessions,
  deletePendingEmailChange,
  emailInUseByAnother,
  EmailTakenError,
  getAuthUserProfile,
  listLoginMethods,
  purgeVerificationsForEmails,
  readPendingEmailChange,
  unlinkLoginMethod,
  upsertPendingEmailChange,
} from "../src/auth-user";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The email-change ceremony's identity-realm primitives, against a real Postgres. The OTP hash lives in
// pending_email_change (0081, DML to webhook_auth only); commit + session revoke + verification purge all run
// as webhook_auth on the global identity tables. These prove the round-trips + the citext uniqueness backstop.

let pg: EphemeralPostgres;
let auth: Sql; // webhook_auth — the identity role the RPC uses
let owner: Sql; // seeds "user"/"session"/"verification" rows
let app: Sql; // webhook_app — the tenant role, which must have NO access to the OTP-hash table

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  auth = createClient(pg.urlFor({ role: DB_ROLES.auth }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
}, setupHookTimeoutMs());

afterAll(async () => {
  await auth?.end();
  await owner?.end();
  await app?.end();
  await pg?.stop();
});

describe("pending_email_change privileges (OTP hashes are webhook_auth-only)", () => {
  it("DENIES webhook_app every DML — the tenant/app role can never read or write the OTP hash", async () => {
    // No grant to webhook_app (0081 grants webhook_auth only), so each of these raises "permission denied".
    await expect(app`select * from pending_email_change`).rejects.toThrow(/permission denied/i);
    await expect(
      app`insert into pending_email_change (user_id, new_email, code_hash, expires_at)
          values ('u', 'x@e.test', '\\x00', now())`,
    ).rejects.toThrow(/permission denied/i);
    await expect(app`update pending_email_change set attempts = 1`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app`delete from pending_email_change`).rejects.toThrow(/permission denied/i);
  });

  it("still lets webhook_auth round-trip (the grant is present for the runtime role)", async () => {
    const u = await seedUser(`priv-${randomUUID().slice(0, 8)}@e.test`);
    await upsertPendingEmailChange(auth, {
      userId: u,
      newEmail: "n@e.test",
      codeHash: new Uint8Array([1, 2, 3]),
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect((await readPendingEmailChange(auth, u))?.newEmail).toBe("n@e.test");
  });
});

async function seedUser(email: string): Promise<string> {
  const id = `user_${randomUUID()}`;
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${"Dana"}, ${email}, ${false}, now())`;
  return id;
}

const bytes = (n: number) =>
  new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256));
const future = () => new Date(Date.now() + 600_000);

describe("emailInUseByAnother", () => {
  it("is true only for a DIFFERENT user holding the address (citext, case-insensitive)", async () => {
    const a = await seedUser(`taken-${randomUUID().slice(0, 8)}@e.test`);
    const [{ email }] = await auth<
      { email: string }[]
    >`select "email" from "user" where "id" = ${a}`;

    // Another user asking for A's address (upper-cased) → taken.
    expect(
      await emailInUseByAnother(auth, { email: email.toUpperCase(), exceptUserId: "someone_else" }),
    ).toBe(true);
    // A asking for their OWN address → not "another" → false (an idempotent no-op change).
    expect(await emailInUseByAnother(auth, { email, exceptUserId: a })).toBe(false);
    // A fresh address → free.
    expect(
      await emailInUseByAnother(auth, { email: `free-${randomUUID()}@e.test`, exceptUserId: a }),
    ).toBe(false);
  });
});

describe("pending_email_change round-trip", () => {
  it("upserts (one per user, resetting attempts) and reads back the hash bytes + target + expiry", async () => {
    const u = await seedUser(`p-${randomUUID().slice(0, 8)}@e.test`);
    const exp = future();
    await upsertPendingEmailChange(auth, {
      userId: u,
      newEmail: "new@e.test",
      codeHash: bytes(1),
      expiresAt: exp,
    });

    const first = await readPendingEmailChange(auth, u);
    expect(first?.newEmail).toBe("new@e.test");
    expect(first?.attempts).toBe(0);
    expect(new Uint8Array(first!.codeHash)).toEqual(bytes(1)); // bytea preserved exactly

    // A second start REPLACES it (unique(user_id)) with a fresh hash + attempts reset to 0.
    await bumpPendingEmailChangeAttempts(auth, u);
    await upsertPendingEmailChange(auth, {
      userId: u,
      newEmail: "newer@e.test",
      codeHash: bytes(2),
      expiresAt: exp,
    });
    const second = await readPendingEmailChange(auth, u);
    expect(second?.newEmail).toBe("newer@e.test");
    expect(second?.attempts).toBe(0);
    expect(new Uint8Array(second!.codeHash)).toEqual(bytes(2));
  });

  it("bumps the attempt counter and deletes cleanly", async () => {
    const u = await seedUser(`a-${randomUUID().slice(0, 8)}@e.test`);
    await upsertPendingEmailChange(auth, {
      userId: u,
      newEmail: "x@e.test",
      codeHash: bytes(3),
      expiresAt: future(),
    });
    expect(await bumpPendingEmailChangeAttempts(auth, u)).toBe(1);
    expect(await bumpPendingEmailChangeAttempts(auth, u)).toBe(2);

    await deletePendingEmailChange(auth, u);
    expect(await readPendingEmailChange(auth, u)).toBeNull();
  });
});

describe("commitEmailChange", () => {
  it("writes the lowercased email + marks it verified", async () => {
    const u = await seedUser(`old-${randomUUID().slice(0, 8)}@e.test`);
    const target = `NEW-${randomUUID().slice(0, 8)}@E.test`;
    expect(await commitEmailChange(auth, { userId: u, newEmail: target })).toBe(true);

    const after = await getAuthUserProfile(auth, u);
    expect(after?.email).toBe(target.toLowerCase()); // stored lowercased
    const [{ v }] = await auth<
      { v: boolean }[]
    >`select "emailVerified" as v from "user" where "id" = ${u}`;
    expect(v).toBe(true);
  });

  it("throws EmailTakenError when the target collides with another account (citext backstop)", async () => {
    const taken = `dup-${randomUUID().slice(0, 8)}@e.test`;
    await seedUser(taken);
    const u = await seedUser(`me-${randomUUID().slice(0, 8)}@e.test`);
    // A case-variant of an existing address must still collide (citext unique).
    await expect(
      commitEmailChange(auth, { userId: u, newEmail: taken.toUpperCase() }),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });
});

describe("session revoke + verification purge", () => {
  it("deletes ALL the user's IdP sessions", async () => {
    const u = await seedUser(`s-${randomUUID().slice(0, 8)}@e.test`);
    for (let i = 0; i < 3; i++) {
      await owner`
        insert into "session" ("id", "token", "userId", "expiresAt", "updatedAt")
        values (${`sess_${randomUUID()}`}, ${`tok_${randomUUID()}`}, ${u}, ${future()}, now())`;
    }
    expect(await deleteAllUserSessions(auth, u)).toBe(3);
    const [{ n }] = await auth<
      { n: number }[]
    >`select count(*)::int as n from "session" where "userId" = ${u}`;
    expect(n).toBe(0);
  });

  it("purges verification rows for BOTH addresses (identifier-keyed), leaving others", async () => {
    const oldE = `old-${randomUUID().slice(0, 8)}@e.test`;
    const newE = `new-${randomUUID().slice(0, 8)}@e.test`;
    const other = `other-${randomUUID().slice(0, 8)}@e.test`;
    for (const id of [oldE, newE, other]) {
      await owner`
        insert into "verification" ("id", "identifier", "value", "expiresAt")
        values (${`v_${randomUUID()}`}, ${id}, ${"tokenhash"}, ${future()})`;
    }
    await purgeVerificationsForEmails(auth, [oldE, newE]);

    const remaining = await auth<{ identifier: string }[]>`
      select "identifier" from "verification" where "identifier" in ${auth([oldE, newE, other])}`;
    expect(remaining.map((r) => r.identifier)).toEqual([other]); // only the unrelated one survives
  });

  it("is a no-op on an empty address list (never issues a delete)", async () => {
    await expect(purgeVerificationsForEmails(auth, [])).resolves.toBeUndefined();
  });
});

describe("login methods (account rows)", () => {
  async function linkAccount(userId: string, providerId: string, accountId: string): Promise<void> {
    await owner`
      insert into "account" ("id", "accountId", "providerId", "userId", "updatedAt")
      values (${`acc_${randomUUID()}`}, ${accountId}, ${providerId}, ${userId}, now())`;
  }

  it("lists a user's linked social sign-ins (newest first) and counts them", async () => {
    const u = await seedUser(`lm-${randomUUID().slice(0, 8)}@e.test`);
    await linkAccount(u, "google", "g-123");
    await linkAccount(u, "github", "gh-456");

    expect(await countLoginMethods(auth, u)).toBe(2);
    const methods = await listLoginMethods(auth, u);
    expect(methods.map((m) => m.providerId).sort()).toEqual(["github", "google"]);
    expect(methods[0]?.accountId).toBeTruthy();
    expect(methods[0]?.linkedAt).toBeInstanceOf(Date);
  });

  it("unlinks exactly the targeted (provider, account) and leaves the rest", async () => {
    const u = await seedUser(`lm2-${randomUUID().slice(0, 8)}@e.test`);
    await linkAccount(u, "google", "g-1");
    await linkAccount(u, "github", "gh-1");

    expect(
      await unlinkLoginMethod(auth, { userId: u, providerId: "google", accountId: "g-1" }),
    ).toBe(true);
    expect(await countLoginMethods(auth, u)).toBe(1);
    expect((await listLoginMethods(auth, u))[0]?.providerId).toBe("github");

    // Unlinking something that isn't there is a false no-op (not an error).
    expect(
      await unlinkLoginMethod(auth, { userId: u, providerId: "google", accountId: "g-1" }),
    ).toBe(false);
  });

  it("scopes the unlink to the caller — it never touches another user's account rows", async () => {
    // (providerId, accountId) is globally unique (0076), so the two accounts differ by accountId; the point is
    // that unlink's WHERE is keyed by userId, so A's delete can't reach B's row.
    const a = await seedUser(`lm3a-${randomUUID().slice(0, 8)}@e.test`);
    const b = await seedUser(`lm3b-${randomUUID().slice(0, 8)}@e.test`);
    await linkAccount(a, "google", "g-a");
    await linkAccount(b, "google", "g-b");

    // Even asked to unlink B's accountId while pinned to A, nothing happens (userId scopes it) — and A's own.
    expect(
      await unlinkLoginMethod(auth, { userId: a, providerId: "google", accountId: "g-b" }),
    ).toBe(false);
    expect(await countLoginMethods(auth, b)).toBe(1); // B untouched by A's attempt

    await unlinkLoginMethod(auth, { userId: a, providerId: "google", accountId: "g-a" });
    expect(await countLoginMethods(auth, a)).toBe(0);
    expect(await countLoginMethods(auth, b)).toBe(1); // still untouched
  });
});
