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
  requireOrgAccess.mockResolvedValue({
    orgId: ORG_ID,
    slug: "acme",
    role: "member",
    userId: "u_caller",
  });
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
      maxAge: 3600,
    });
  });

  it("keeps the SHORT default for the caller's OWN row — the Team page renders it too", async () => {
    // "Nothing here is yours" was wrong: team-manager renders the caller's own row through MemberAvatar
    // (badged "You"), and MemberAvatar carries no ?v= cache-bust. An hour-long cache there has nothing to
    // bust it — upload a new avatar, see it right on /account/profile, then find your own face stale on Team
    // for an hour, unfixable short of a hard reload. The 60s default exists for exactly this; it just has to
    // apply per-ROW.
    listOrgMembers.mockResolvedValue([member("u_caller")]);
    await GET(req(), ctx("acme", "u_caller"));
    expect(serveAvatar).toHaveBeenCalledWith(
      expect.not.objectContaining({ maxAge: expect.anything() }),
    );
  });

  it("asks for a REAL cache TTL — serveAvatar's 60s default made the Team page an N+1 per refresh", async () => {
    // serveAvatar defaults to 60s so YOUR OWN re-upload appears without a hard refresh. Nothing here is
    // yours, and at 60s every Team-page load refetched every member — each refetch paying requireOrgAccess
    // AND a full listOrgMembers before it even reached R2. That was the multi-second avatar delay. This is a
    // header, so nothing else would fail if it silently regressed to the default.
    listOrgMembers.mockResolvedValue([member("u_target")]);
    await GET(req(), ctx("acme", "u_target"));
    expect(serveAvatar).toHaveBeenCalledWith(expect.objectContaining({ maxAge: 3600 }));
  });

  it("404s (never serves) when the target is NOT a co-member — can't fetch a stranger's face", async () => {
    listOrgMembers.mockResolvedValue([member("someone_else")]); // u_target absent
    const res = await GET(req(), ctx("acme", "u_target"));
    expect(res.status).toBe(404);
    expect(serveAvatar).not.toHaveBeenCalled();
    expect(noAvatarResponse).toHaveBeenCalled();
  });

  it("gives the stranger-404 the SAME TTL a co-member-without-an-avatar gets — no membership oracle", async () => {
    // Both answers are a 404 with no body; Cache-Control is the only field that could separate them, so it
    // must not. A 60s stranger-404 beside a 3600s member-404 turns this route into "is <userId> in your org?"
    // for any id an attacker cares to probe — a membership disclosure from a route whose own comment is
    // "reveal nothing". They were byte-identical until noAvatarResponse gained a 60s default.
    listOrgMembers.mockResolvedValue([member("someone_else")]);
    await GET(req(), ctx("acme", "u_target"));
    expect(noAvatarResponse).toHaveBeenCalledWith(3600);

    // …and that 3600 is exactly what a co-member with no avatar resolves to, via serveAvatar's own 404 exit.
    vi.clearAllMocks();
    requireOrgAccess.mockResolvedValue({
      orgId: ORG_ID,
      slug: "acme",
      role: "member",
      userId: "u_caller",
    });
    listOrgMembers.mockResolvedValue([member("u_target")]);
    await GET(req(), ctx("acme", "u_target"));
    expect(serveAvatar).toHaveBeenCalledWith(expect.objectContaining({ maxAge: 3600 }));
  });

  it("uses the RESOLVED org id from requireOrgAccess for the membership lookup (not the raw slug)", async () => {
    await GET(req(), ctx("acme", "u_target"));
    expect(listOrgMembers).toHaveBeenCalledWith(expect.anything(), ORG_ID);
  });
});
