import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({
    userId: "u_1",
    orgId: "o_1",
    user: { name: "D", email: "e" },
  })),
}));
vi.mock("@/server/session", () => ({ verifySession }));

const { put, getAvatarBucket } = vi.hoisted(() => {
  const put = vi.fn(async () => {});
  return { put, getAvatarBucket: vi.fn(async () => ({ put, get: vi.fn(), delete: vi.fn() })) };
});
vi.mock("@/server/avatar-r2", () => ({ getAvatarBucket }));

const { updateImageKey, getOnboardingBinding } = vi.hoisted(() => {
  const updateImageKey = vi.fn(async () => ({ updated: true }));
  return { updateImageKey, getOnboardingBinding: vi.fn(() => ({ updateImageKey })) };
});
vi.mock("@/server/env", () => ({ getOnboardingBinding }));
vi.mock("@/server/action-log", () => ({ logActionError: vi.fn() }));

import { POST } from "./route";

const ORIGIN = "https://app.test";
const URL_STR = `${ORIGIN}/api/avatar/upload`;

/** A minimal, VALID square webp (VP8 lossy) of the given side, for the happy path + validation. */
function squareWebp(side: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23); // start code
  b[26] = side & 0xff;
  b[27] = (side >> 8) & 0x3f;
  b[28] = side & 0xff;
  b[29] = (side >> 8) & 0x3f;
  return b;
}

function req(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL_STR, {
    method: "POST",
    headers: { origin: ORIGIN, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue(undefined);
  getAvatarBucket.mockResolvedValue({ put, get: vi.fn(), delete: vi.fn() });
  getOnboardingBinding.mockReturnValue({ updateImageKey });
  updateImageKey.mockResolvedValue({ updated: true });
});

describe("POST /api/avatar/upload", () => {
  it("rejects a cross-origin request (403) BEFORE touching the session or body", async () => {
    const r = new Request(URL_STR, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: squareWebp(128),
    });
    expect((await POST(r)).status).toBe(403);
    expect(verifySession).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin (403, fail closed)", async () => {
    const r = new Request(URL_STR, { method: "POST", body: squareWebp(128) });
    expect((await POST(r)).status).toBe(403);
  });

  it("rejects an oversize body by Content-Length (413)", async () => {
    const r = req(squareWebp(128), { "content-length": String(999_999) });
    expect((await POST(r)).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a non-image body (415)", async () => {
    const r = req(new TextEncoder().encode("<svg/>"));
    expect((await POST(r)).status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a non-square image (415)", async () => {
    // A 128×64 webp: tweak the height field.
    const b = squareWebp(128);
    b[28] = 64 & 0xff;
    b[29] = (64 >> 8) & 0x3f;
    expect((await POST(req(b))).status).toBe(415);
  });

  it("stores the webp in R2 and points the identity row at it, returning ok", async () => {
    const res = await POST(req(squareWebp(256)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Key derived from the VERIFIED userId; served type forced to webp.
    expect(put).toHaveBeenCalledWith("user/u_1/avatar.webp", expect.anything(), {
      httpMetadata: { contentType: "image/webp" },
    });
    expect(updateImageKey).toHaveBeenCalledWith("u_1", "user/u_1/avatar.webp");
  });

  it("does NOT point the identity row if the R2 store fails (502)", async () => {
    put.mockRejectedValueOnce(new Error("r2 down"));
    expect((await POST(req(squareWebp(128)))).status).toBe(502);
    expect(updateImageKey).not.toHaveBeenCalled();
  });

  it("returns 502 when the identity RPC throws (object stored, pointer not set)", async () => {
    updateImageKey.mockRejectedValueOnce(new Error("rpc down"));
    expect((await POST(req(squareWebp(128)))).status).toBe(502);
  });

  it("is unavailable (503) when the R2 binding is absent", async () => {
    getAvatarBucket.mockResolvedValueOnce(undefined);
    expect((await POST(req(squareWebp(128)))).status).toBe(503);
  });
});
