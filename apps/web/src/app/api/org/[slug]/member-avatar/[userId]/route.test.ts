import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOrgAccess } = vi.hoisted(() => ({ requireOrgAccess: vi.fn() }));
vi.mock("@/server/org-access", () => ({ requireOrgAccess: (s: string) => requireOrgAccess(s) }));

const { listOrgMembers } = vi.hoisted(() => ({ listOrgMembers: vi.fn() }));
vi.mock("@webhook-co/db/members", () => ({ listOrgMembers }));

vi.mock("@/server/db", () => ({ getTenantDb: async () => ({}) }));

const { serveAvatar, noAvatarResponse } = vi.hoisted(() => ({
  serveAvatar: vi.fn(async () => new Response("bytes", { status: 200 })),
  noAvatarResponse: vi.fn(() => new Response(null, { status: 404 })),
}));
vi.mock("@/server/avatar-serve", () => ({ serveAvatar, noAvatarResponse }));

import { GET } from "./route";

const ORG_ID = "9b5ac09c-b60c-4998-9b95-51dd53dec8da";
const ctx = (slug = "acme", userId = "u_target") => ({ params: Promise.resolve({ slug, userId }) });
const req = () => new Request("https://app.test/api/org/acme/member-avatar/u_target");

const member = (userId: string, over: Partial<{ image: string | null; email: string }> = {}) => ({
  userId,
  name: "Dana",
  email: "dana@e.test",
  role: "member" as const,
  joinedAt: "2026-01-01",
  image: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({ orgId: ORG_ID, slug: "acme", role: "member" });
  listOrgMembers.mockResolvedValue([member("u_target"), member("u_other")]);
});

describe("GET /api/org/[slug]/member-avatar/[userId]", () => {
  it("is gated — a non-member requester is 404'd by requireOrgAccess before any lookup", async () => {
    requireOrgAccess.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(GET(req(), ctx())).rejects.toThrow();
    expect(listOrgMembers).not.toHaveBeenCalled();
    expect(serveAvatar).not.toHaveBeenCalled();
  });

  it("serves a CO-MEMBER's avatar (R2 key from the target userId + their proxied provider image)", async () => {
    listOrgMembers.mockResolvedValue([
      member("u_target", { image: "https://avatars.githubusercontent.com/u/1", email: "t@e.test" }),
    ]);
    const res = await GET(req(), ctx("acme", "u_target"));
    expect(res.status).toBe(200);
    expect(serveAvatar).toHaveBeenCalledWith({
      r2Key: "user/u_target/avatar.webp",
      image: "https://avatars.githubusercontent.com/u/1",
      email: "t@e.test",
    });
  });

  it("404s (never serves) when the target is NOT a co-member — can't fetch a stranger's face", async () => {
    listOrgMembers.mockResolvedValue([member("someone_else")]); // u_target absent
    const res = await GET(req(), ctx("acme", "u_target"));
    expect(res.status).toBe(404);
    expect(serveAvatar).not.toHaveBeenCalled();
    expect(noAvatarResponse).toHaveBeenCalled();
  });

  it("uses the RESOLVED org id from requireOrgAccess for the membership lookup (not the raw slug)", async () => {
    await GET(req(), ctx("acme", "u_target"));
    expect(listOrgMembers).toHaveBeenCalledWith(expect.anything(), ORG_ID);
  });
});
