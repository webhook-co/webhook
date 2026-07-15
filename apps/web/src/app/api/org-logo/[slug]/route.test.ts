import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOrgAccess } = vi.hoisted(() => ({ requireOrgAccess: vi.fn() }));
vi.mock("@/server/org-access", () => ({ requireOrgAccess: (s: string) => requireOrgAccess(s) }));

const { getAvatarBucket } = vi.hoisted(() => ({ getAvatarBucket: vi.fn() }));
vi.mock("@/server/avatar-r2", () => ({ getAvatarBucket }));

vi.mock("@/server/action-log", () => ({ logActionError: vi.fn() }));

import { GET } from "./route";

const ORG_ID = "9b5ac09c-b60c-4998-9b95-51dd53dec8da";
const KEY = `org/${ORG_ID}/logo.webp`;
const ctx = (slug = "acme") => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({ orgId: ORG_ID, slug: "acme", role: "member" });
  getAvatarBucket.mockResolvedValue(undefined);
});

describe("GET /api/org-logo/[slug]", () => {
  it("is gated — resolves org access (which 404s a non-member) before anything else", async () => {
    requireOrgAccess.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(GET(new Request("https://app.test/api/org-logo/acme"), ctx())).rejects.toThrow();
    expect(getAvatarBucket).not.toHaveBeenCalled();
  });

  it("serves the org logo from R2 (forced image/webp, nosniff), keyed by the RESOLVED org id", async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const get = vi.fn(async (key: string) =>
      key === KEY ? { arrayBuffer: async () => buf } : null,
    );
    getAvatarBucket.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() });

    const res = await GET(new Request("https://app.test/api/org-logo/acme"), ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // Member-gated, so private + Vary on the cookie — never a shared cache across the membership boundary.
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("answers 404 (not 204) when the org has no logo, so the <img> fallback fires", async () => {
    const get = vi.fn(async () => null);
    getAvatarBucket.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() });

    const res = await GET(new Request("https://app.test/api/org-logo/acme"), ctx());
    expect(res.status).toBe(404);
  });

  it("answers 404 when the R2 binding is absent (dev), never throws", async () => {
    getAvatarBucket.mockResolvedValue(undefined);
    const res = await GET(new Request("https://app.test/api/org-logo/acme"), ctx());
    expect(res.status).toBe(404);
  });

  it("answers 404 rather than failing the page if R2 get throws", async () => {
    const get = vi.fn(async () => {
      throw new Error("r2 hiccup");
    });
    getAvatarBucket.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() });
    const res = await GET(new Request("https://app.test/api/org-logo/acme"), ctx());
    expect(res.status).toBe(404);
  });
});
