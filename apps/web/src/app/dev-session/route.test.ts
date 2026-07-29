import { afterEach, describe, expect, it, vi } from "vitest";

const { TEST_SECRET } = vi.hoisted(() => ({ TEST_SECRET: "dev-session-test-secret-aaaaaaaaaaaa" }));
vi.mock("@/server/env", () => ({
  getSessionSecret: async () => TEST_SECRET,
  getAuthBaseUrl: () => "http://auth.test",
}));

import { SESSION_COOKIE } from "@/server/session";
import { verifySessionToken } from "@/server/session-token";

import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

/** The session this response would establish, or null if it set no cookie. */
async function sessionFrom(res: Response) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const part = setCookie.split(/;\s*/).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  if (!part) return null;
  const value = decodeURIComponent(part.slice(SESSION_COOKIE.length + 1));
  return verifySessionToken(value, TEST_SECRET);
}

// The default principal is a CONTRACT with the local-dev seeder: `pnpm seed` creates exactly this user in
// exactly this org. If either side changes alone, the seeded database stops matching the session this route
// mints, and the symptom is an unexplained bounce back to sign-in with no error anywhere.
//
// This DECODES the minted session and compares it to the seeder's own exports. Asserting that the seed
// exports equal literals copied into this file would pin nothing: the route could change freely and the
// test would still pass, which is the exact drift it claims to catch.
describe("the default principal matches what `pnpm seed` creates", () => {
  it("mints the seeder's user id and org id", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { DEV_PRINCIPAL, DEV_PRIMARY_ORG_ID } = await import("@webhook-co/db/seed");

    const session = await sessionFrom(await GET(new Request("http://localhost:3000/dev-session")));

    expect(session?.userId).toBe(DEV_PRINCIPAL.userId);
    expect(session?.orgId).toBe(DEV_PRIMARY_ORG_ID);
  });
});

describe("GET /dev-session", () => {
  it("returns 404 in production — never a real auth path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(new Request("http://localhost:3000/dev-session"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ignores user/org overrides in production — they are not a way in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(
      new Request(
        "http://localhost:3000/dev-session?user=attacker&org=11111111-1111-4111-8111-111111111111",
      ),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("mints a valid signed session cookie outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(new Request("http://localhost:3000/dev-session"));

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/HttpOnly/i);

    // the cookie is a real, verifiable session token (not the old opaque "dev-mock" string)
    const session = await sessionFrom(res);
    expect(session?.orgId).toBeTruthy();
    expect(session?.userId).toBeTruthy();
  });

  it("mints the default org as a real UUID — a non-UUID org id is a 22P02 against a real Postgres", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const session = await sessionFrom(await GET(new Request("http://localhost:3000/dev-session")));
    expect(session?.orgId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("mints the requested principal — the seam the e2e suite seeds a two-org fixture through", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_SESSION_PRINCIPAL_OVERRIDE", "1");
    const org = "3f2b1c8e-9d4a-4c7b-8e1f-2a5d6c7b8e9f";
    const res = await GET(
      new Request(`http://localhost:3000/dev-session?user=usr_dana&org=${org}`),
    );

    const session = await sessionFrom(res);
    expect(session?.userId).toBe("usr_dana");
    expect(session?.orgId).toBe(org);
  });

  it("refuses a non-UUID org rather than minting a session that cannot address a tenant", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_SESSION_PRINCIPAL_OVERRIDE", "1");
    const res = await GET(
      new Request("http://localhost:3000/dev-session?user=usr_dana&org=not-a-uuid"),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the principal override without the explicit opt-in — two gates, not one", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // DEV_SESSION_PRINCIPAL_OVERRIDE deliberately unset. The prod 404 is build-time constant-folded and
    // cannot be flipped by an env var — but it must not be the ONLY thing standing between an anonymous
    // caller and a signed cookie for any user in any org.
    const res = await GET(
      new Request(
        "http://localhost:3000/dev-session?user=usr_victim&org=3f2b1c8e-9d4a-4c7b-8e1f-2a5d6c7b8e9f",
      ),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still mints the DEFAULT principal without the opt-in — the override is what is gated", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(new Request("http://localhost:3000/dev-session"));

    expect(res.status).toBe(307);
    expect((await sessionFrom(res))?.userId).toBe("usr_dev_local");
  });

  it("refuses an empty user rather than minting an unattributable session", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_SESSION_PRINCIPAL_OVERRIDE", "1");
    const res = await GET(new Request("http://localhost:3000/dev-session?user="));

    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
