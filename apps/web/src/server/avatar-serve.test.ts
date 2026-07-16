import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAvatarBucket } = vi.hoisted(() => ({ getAvatarBucket: vi.fn() }));
vi.mock("@/server/avatar-r2", () => ({ getAvatarBucket }));

const { resolveAvatarSource } = vi.hoisted(() => ({ resolveAvatarSource: vi.fn() }));
vi.mock("@/server/avatar", () => ({ resolveAvatarSource }));

vi.mock("@/server/action-log", () => ({ logActionError: vi.fn() }));

import { noAvatarResponse, serveAvatar } from "./avatar-serve";

const IDENTITY = { r2Key: "user/u_1/avatar.webp", image: null, email: "dana@e.test" };
const cache = (res: Response) => res.headers.get("Cache-Control");

/** An R2 bucket whose `get` returns an object (an uploaded avatar exists). */
const bucketWithObject = () => ({
  get: vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })),
});
/** An R2 bucket with no object for this key — the state of every user who has never uploaded. */
const emptyBucket = () => ({ get: vi.fn(async () => null) });

beforeEach(() => {
  vi.clearAllMocks();
  getAvatarBucket.mockResolvedValue(emptyBucket());
  resolveAvatarSource.mockResolvedValue({ kind: "none" });
});

// `maxAge` exists so a caller serving SOMEONE ELSE's face can buy a real TTL, while your OWN face keeps the
// short default that makes a fresh upload appear without a hard refresh. It only does that job if it reaches
// EVERY exit. It originally threaded into the R2-hit branch alone, so the two exits that actually serve a
// first-time uploader — the 404 and the provider proxy — hardcoded an hour and ignored it entirely. These
// are response headers: nothing else in the suite fails if one silently reverts to a hardcoded value.
describe("serveAvatar cache TTL", () => {
  it("defaults an uploaded avatar to 60s — your own re-upload must appear without a hard refresh", async () => {
    getAvatarBucket.mockResolvedValue(bucketWithObject());
    expect(cache(await serveAvatar(IDENTITY))).toBe("private, max-age=60");
  });

  it("honours a caller's TTL for an uploaded avatar", async () => {
    getAvatarBucket.mockResolvedValue(bucketWithObject());
    expect(cache(await serveAvatar({ ...IDENTITY, maxAge: 3600 }))).toBe("private, max-age=3600");
  });

  it("defaults the NO-AVATAR 404 to 60s — the path a first upload actually has to invalidate", async () => {
    // The common case, and the one the R2-only fix missed: a user with no avatar loads Team, their own row
    // 404s and caches for an hour, they upload, see it on /account/profile, and find their own face still
    // initials on Team — MemberAvatar carries no ?v= to bust it. `isSelf` was inert for exactly this user.
    const res = await serveAvatar(IDENTITY);
    expect(res.status).toBe(404);
    expect(cache(res)).toBe("private, max-age=60");
  });

  it("honours a caller's TTL on the 404 too — a co-member's absent avatar can cache for an hour", async () => {
    const res = await serveAvatar({ ...IDENTITY, maxAge: 3600 });
    expect(res.status).toBe(404);
    expect(cache(res)).toBe("private, max-age=3600");
  });

  it("defaults the PROVIDER-PROXY image to 60s — the other path a first upload must invalidate", async () => {
    resolveAvatarSource.mockResolvedValue({
      kind: "provider",
      url: "https://avatars.githubusercontent.com/u/1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bytes", { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    const res = await serveAvatar(IDENTITY);
    expect(res.status).toBe(200);
    expect(cache(res)).toBe("private, max-age=60");
  });

  it("honours a caller's TTL on the provider proxy", async () => {
    resolveAvatarSource.mockResolvedValue({
      kind: "provider",
      url: "https://avatars.githubusercontent.com/u/1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bytes", { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    expect(cache(await serveAvatar({ ...IDENTITY, maxAge: 3600 }))).toBe("private, max-age=3600");
  });

  it("applies the same TTL rule to the GRAVATAR exit — the other real AvatarSource variant", async () => {
    // AvatarSource is exactly `provider | gravatar | none` (avatar.ts). Both non-`none` variants reach the
    // same proxy code path, so pin gravatar too rather than assume "provider covers it" — an earlier draft of
    // this file mocked a `{kind:"proxy"}` that the union does not contain, which exercised the branch only by
    // accident and asserted nothing about a shape production can actually produce.
    resolveAvatarSource.mockResolvedValue({
      kind: "gravatar",
      url: "https://gravatar.com/avatar/abc",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bytes", { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    expect(cache(await serveAvatar(IDENTITY))).toBe("private, max-age=60");
    expect(cache(await serveAvatar({ ...IDENTITY, maxAge: 3600 }))).toBe("private, max-age=3600");
  });
});

describe("noAvatarResponse", () => {
  it("is a 404 (never 204) so the <img> fires error and the initials fallback runs", () => {
    const res = noAvatarResponse();
    expect(res.status).toBe(404);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("defaults to the short TTL, and accepts a longer one", () => {
    expect(cache(noAvatarResponse())).toBe("private, max-age=60");
    expect(cache(noAvatarResponse(3600))).toBe("private, max-age=3600");
  });
});
