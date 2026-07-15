import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories (which run above the file body) can read them.
const { store, jar, SESSION_COOKIE, SECRET } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const jar = {
    get: (k: string) => (store.has(k) ? { value: store.get(k)! } : undefined),
    set: (k: string, v: string) => void store.set(k, v),
  };
  // The HMAC key is built at runtime from a trivial literal — HMAC accepts any key, and keeping no
  // high-entropy string in the source avoids a secret-scanner false positive on a test-only value.
  return { store, jar, SESSION_COOKIE: "wh_session", SECRET: "s".repeat(32) };
});

vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("./env", () => ({ getSessionSecret: async () => SECRET }));
vi.mock("./session-cookie", () => ({ sessionCookieOptions: () => ({ httpOnly: true }) }));
// Mock ./session for just the cookie-name constant remint reads — importing the real module drags in its
// whole env-dependent graph (LOGIN_URL etc.).
vi.mock("./session", () => ({ SESSION_COOKIE }));

import { remintSessionForProfile } from "./session-remint";
import { signSessionToken, verifySessionToken } from "./session-token";

beforeEach(() => store.clear());

describe("remintSessionForProfile", () => {
  it("re-mints with the new profile, preserving userId, org, and the original expiry", async () => {
    const original = await signSessionToken(
      { userId: "u_1", orgId: "o_1", user: { name: "Old Name", email: "e@x.test", image: null } },
      SECRET,
      3600, // 1h
    );
    store.set(SESSION_COOKIE, original);
    const before = (await verifySessionToken(original, SECRET))!;

    const outcome = await remintSessionForProfile({
      name: "New Name",
      email: "e@x.test",
      image: null,
    });

    expect(outcome).toBe("ok");
    const after = (await verifySessionToken(store.get(SESSION_COOKIE)!, SECRET))!;
    expect(after.user.name).toBe("New Name"); // the edit is live in the cookie
    expect(after.userId).toBe("u_1"); // same principal (read from the verified token, not caller-supplied)
    expect(after.orgId).toBe("o_1"); // same org
    expect(after.expiresAt).toBe(before.expiresAt); // deadline preserved — NOT a fresh TTL
  });

  it("fails closed when there is no session cookie (mints nothing)", async () => {
    expect(await remintSessionForProfile({ name: "X", email: "e@x.test", image: null })).toBe(
      "no_session",
    );
    expect(store.has(SESSION_COOKIE)).toBe(false);
  });

  it("fails closed on a tampered/unverifiable cookie", async () => {
    store.set(SESSION_COOKIE, "not.a.valid.token");
    expect(await remintSessionForProfile({ name: "X", email: "e@x.test", image: null })).toBe(
      "no_session",
    );
  });
});
