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

describe("GET /dev-session", () => {
  it("returns 404 in production — never a real auth path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(new Request("http://localhost:3000/dev-session"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("mints a valid signed session cookie outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(new Request("http://localhost:3000/dev-session"));

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    const part = setCookie.split(/;\s*/).find((p) => p.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const value = decodeURIComponent(part.slice(SESSION_COOKIE.length + 1));

    // the cookie is a real, verifiable session token (not the old opaque "dev-mock" string)
    const session = await verifySessionToken(value, TEST_SECRET);
    expect(session?.orgId).toBeTruthy();
    expect(session?.userId).toBeTruthy();
  });
});
