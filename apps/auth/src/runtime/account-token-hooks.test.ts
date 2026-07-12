import { describe, expect, it } from "vitest";

import {
  makeAccountTokenHooks,
  STRIPPED_ACCOUNT_TOKENS,
  withAccountTokenStripping,
} from "./account-token-hooks";

// Data minimization (compliance-by-design): webhook.co uses social OAuth for IDENTITY ONLY — nothing reads
// the provider access/refresh/id tokens after login (Google issues no refresh token without offline access,
// GitHub OAuth apps none at all, and an id_token is consumed at sign-in and useless afterward). Better Auth
// stores all three by default; these hooks strip them on EVERY account write so no provider OAuth token is
// ever persisted — plaintext or otherwise. The one-shot backfill (migration 0061) nulls pre-existing rows.

/** A representative account row Better Auth would try to persist after a social sign-in. */
const account = (over: Record<string, unknown> = {}) => ({
  id: "acc_1",
  accountId: "google-sub-123",
  providerId: "google",
  userId: "usr_1",
  accessToken: "ya29.a0-SECRET-access-token",
  refreshToken: "1//refresh-SECRET",
  idToken: "eyJhbGciOi.SECRET.jwt",
  accessTokenExpiresAt: new Date(0),
  scope: "openid email profile",
  ...over,
});

describe("makeAccountTokenHooks", () => {
  it("create.before nulls all three OAuth token columns", async () => {
    const hooks = makeAccountTokenHooks();
    const result = await hooks.account.create.before(account());
    expect(result).toEqual({ data: { accessToken: null, refreshToken: null, idToken: null } });
  });

  it("update.before nulls all three OAuth token columns too (re-auth refreshes them)", async () => {
    const hooks = makeAccountTokenHooks();
    const result = await hooks.account.update.before(account());
    expect(result).toEqual({ data: { accessToken: null, refreshToken: null, idToken: null } });
  });

  it("only overrides the token columns — Better Auth merges result.data over the row, so identity/link fields survive", async () => {
    // Better Auth does `{ ...actualData, ...result.data }`; our result.data must therefore touch ONLY the
    // token fields, or it would clobber accountId/providerId/userId (which link the identity).
    const hooks = makeAccountTokenHooks();
    const { data } = await hooks.account.create.before(account());
    expect(Object.keys(data).sort()).toEqual(["accessToken", "idToken", "refreshToken"]);
    // Simulate the merge Better Auth performs and assert the linkage columns are untouched + tokens gone.
    const merged = { ...account(), ...data };
    expect(merged.accountId).toBe("google-sub-123");
    expect(merged.providerId).toBe("google");
    expect(merged.userId).toBe("usr_1");
    expect(merged.scope).toBe("openid email profile");
    expect(merged.accessToken).toBeNull();
    expect(merged.refreshToken).toBeNull();
    expect(merged.idToken).toBeNull();
  });

  it("never returns the incoming secret values (defense against an accidental echo)", async () => {
    const hooks = makeAccountTokenHooks();
    const json = JSON.stringify(await hooks.account.create.before(account()));
    expect(json).not.toMatch(/SECRET/);
  });

  it("STRIPPED_ACCOUNT_TOKENS pins exactly the three token columns to null", () => {
    expect(STRIPPED_ACCOUNT_TOKENS).toEqual({
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
  });
});

describe("withAccountTokenStripping", () => {
  it("installs the account create/update before hooks", () => {
    const composed = withAccountTokenStripping(undefined);
    expect(typeof composed.account.create.before).toBe("function");
    expect(typeof composed.account.update.before).toBe("function");
  });

  it("preserves other models' hooks (the signup→bootstrap user/session hooks)", () => {
    const userAfter = async () => {};
    const sessionAfter = async () => {};
    const composed = withAccountTokenStripping({
      user: { create: { after: userAfter } },
      session: { create: { after: sessionAfter } },
    } as never);
    expect(composed.user?.create?.after).toBe(userAfter);
    expect(composed.session?.create?.after).toBe(sessionAfter);
  });

  it("preserves an existing account.create.after while installing our before (composition, not clobber)", () => {
    const accountAfter = async () => {};
    const composed = withAccountTokenStripping({
      account: { create: { after: accountAfter } },
    } as never);
    expect(composed.account.create.after).toBe(accountAfter);
    expect(typeof composed.account.create.before).toBe("function");
  });

  it("the installed hook actually strips (end-to-end through the composed object)", async () => {
    const composed = withAccountTokenStripping(undefined);
    const result = await composed.account.create.before(account());
    expect(result).toEqual({ data: { accessToken: null, refreshToken: null, idToken: null } });
  });
});
