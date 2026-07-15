import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOrgAccess } = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "u_1",
    orgId: "9b5ac09c-b60c-4998-9b95-51dd53dec8da",
    slug: "acme",
    name: "Acme",
    role: "owner" as string,
  })),
}));
vi.mock("@/server/org-access", () => ({ requireOrgAccess: (s: string) => requireOrgAccess(s) }));

const { put, del, getAvatarBucket } = vi.hoisted(() => {
  const put = vi.fn(async () => {});
  const del = vi.fn(async () => {});
  return { put, del, getAvatarBucket: vi.fn(async () => ({ put, get: vi.fn(), delete: del })) };
});
vi.mock("@/server/avatar-r2", () => ({ getAvatarBucket }));

const { updateOrgImageKey, withTenantDb } = vi.hoisted(() => {
  const updateOrgImageKey = vi.fn(async () => {});
  return {
    updateOrgImageKey,
    // withTenantDb just runs the callback with a fake app handle.
    withTenantDb: vi.fn(async (fn: (app: unknown) => Promise<unknown>) => fn({})),
  };
});
vi.mock("@webhook-co/db", () => ({ updateOrgImageKey }));
vi.mock("@/server/db", () => ({ withTenantDb }));

vi.mock("@/server/env", () => ({ getAppBaseUrl: () => "https://app.test" }));
vi.mock("@/server/action-log", () => ({ logActionError: vi.fn() }));

import { DELETE, POST } from "./route";

const ORIGIN = "https://app.test";
const SLUG = "acme";
const ORG_ID = "9b5ac09c-b60c-4998-9b95-51dd53dec8da";
const URL_STR = `${ORIGIN}/api/org-logo/${SLUG}/upload`;
const KEY = `org/${ORG_ID}/logo.webp`;

/** A minimal, VALID square webp (VP8 lossy) of the given side. */
function squareWebp(side: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23);
  b[26] = side & 0xff;
  b[27] = (side >> 8) & 0x3f;
  b[28] = side & 0xff;
  b[29] = (side >> 8) & 0x3f;
  return b;
}

/** A minimal, VALID square PNG (header only — the validator never decodes). Passes shared validation as a
 *  png, so it exercises the route's webp-ONLY gate specifically. */
function squarePng(side: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length (13)
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(b.buffer);
  dv.setUint32(16, side); // width  (big-endian)
  dv.setUint32(20, side); // height (big-endian)
  return b;
}

function req(body: BodyInit | null, headers: Record<string, string> = {}, slug = SLUG): Request {
  return new Request(`${ORIGIN}/api/org-logo/${slug}/upload`, {
    method: "POST",
    headers: { origin: ORIGIN, ...headers },
    body,
  });
}
const ctx = (slug = SLUG) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue(undefined);
  del.mockResolvedValue(undefined);
  getAvatarBucket.mockResolvedValue({ put, get: vi.fn(), delete: del });
  updateOrgImageKey.mockResolvedValue(undefined);
  withTenantDb.mockImplementation((fn: (app: unknown) => Promise<unknown>) => fn({}));
  requireOrgAccess.mockResolvedValue({
    userId: "u_1",
    orgId: ORG_ID,
    slug: SLUG,
    name: "Acme",
    role: "owner",
  });
});

describe("POST /api/org-logo/[slug]/upload", () => {
  it("rejects a cross-origin request (403) BEFORE touching the session or body", async () => {
    const r = new Request(URL_STR, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: squareWebp(128),
    });
    expect((await POST(r, ctx())).status).toBe(403);
    expect(requireOrgAccess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin (403, fail closed)", async () => {
    const r = new Request(URL_STR, { method: "POST", body: squareWebp(128) });
    expect((await POST(r, ctx())).status).toBe(403);
  });

  it("forbids a non-owner/admin member (403) — logo is org branding, like the name", async () => {
    requireOrgAccess.mockResolvedValue({
      userId: "u_1",
      orgId: ORG_ID,
      slug: SLUG,
      name: "Acme",
      role: "member",
    });
    expect((await POST(req(squareWebp(128)), ctx())).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
    expect(updateOrgImageKey).not.toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    requireOrgAccess.mockResolvedValue({
      userId: "u_1",
      orgId: ORG_ID,
      slug: SLUG,
      name: "Acme",
      role: "admin",
    });
    expect((await POST(req(squareWebp(256)), ctx())).status).toBe(200);
  });

  it("rejects an oversize body by Content-Length (413)", async () => {
    const r = req(squareWebp(128), { "content-length": String(999_999) });
    expect((await POST(r, ctx())).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a non-image body (415)", async () => {
    expect((await POST(req(new TextEncoder().encode("<svg/>")), ctx())).status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a non-square image (415)", async () => {
    const b = squareWebp(128);
    b[28] = 64 & 0xff;
    b[29] = (64 >> 8) & 0x3f;
    expect((await POST(req(b), ctx())).status).toBe(415);
  });

  it("rejects a valid square PNG/JPEG (415) — we store + serve one webp, so the webp-only gate matters", async () => {
    // Passes shared validation (real square png), but the route requires webp specifically.
    expect((await POST(req(squarePng(128)), ctx())).status).toBe(415);
    expect(put).not.toHaveBeenCalled();
    expect(updateOrgImageKey).not.toHaveBeenCalled();
  });

  it("stores the webp under the org key and points the org row at it, returning ok", async () => {
    const res = await POST(req(squareWebp(256)), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(put).toHaveBeenCalledWith(KEY, expect.anything(), {
      httpMetadata: { contentType: "image/webp" },
    });
    expect(updateOrgImageKey).toHaveBeenCalledWith(expect.anything(), ORG_ID, KEY);
  });

  it("does NOT point the org row if the R2 store fails (502)", async () => {
    put.mockRejectedValueOnce(new Error("r2 down"));
    expect((await POST(req(squareWebp(128)), ctx())).status).toBe(502);
    expect(updateOrgImageKey).not.toHaveBeenCalled();
  });

  it("rolls back the R2 put and returns 502 when the pointer write throws", async () => {
    updateOrgImageKey.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(req(squareWebp(128)), ctx())).status).toBe(502);
    expect(del).toHaveBeenCalledWith(KEY);
  });

  it("is unavailable (503) when the R2 binding is absent", async () => {
    getAvatarBucket.mockResolvedValueOnce(undefined);
    expect((await POST(req(squareWebp(128)), ctx())).status).toBe(503);
  });
});

function delReq(headers: Record<string, string> = {}): Request {
  return new Request(URL_STR, { method: "DELETE", headers: { origin: ORIGIN, ...headers } });
}

describe("DELETE /api/org-logo/[slug]/upload (remove)", () => {
  it("rejects a cross-origin request (403) before touching the session", async () => {
    const r = new Request(URL_STR, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect((await DELETE(r, ctx())).status).toBe(403);
    expect(requireOrgAccess).not.toHaveBeenCalled();
  });

  it("forbids a non-owner/admin member (403)", async () => {
    requireOrgAccess.mockResolvedValue({
      userId: "u_1",
      orgId: ORG_ID,
      slug: SLUG,
      name: "Acme",
      role: "member",
    });
    expect((await DELETE(delReq(), ctx())).status).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the R2 object THEN clears the pointer, returning ok", async () => {
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith(KEY);
    expect(updateOrgImageKey).toHaveBeenCalledWith(expect.anything(), ORG_ID, null);
  });

  it("stops (502) and does NOT clear the pointer when the object delete fails (stay consistent)", async () => {
    del.mockRejectedValueOnce(new Error("r2 down"));
    expect((await DELETE(delReq(), ctx())).status).toBe(502);
    expect(updateOrgImageKey).not.toHaveBeenCalled();
  });

  it("still returns ok if only the pointer-clear fails (the visible logo is already gone)", async () => {
    updateOrgImageKey.mockRejectedValueOnce(new Error("db blip"));
    expect((await DELETE(delReq(), ctx())).status).toBe(200);
    expect(del).toHaveBeenCalledWith(KEY);
  });
});
