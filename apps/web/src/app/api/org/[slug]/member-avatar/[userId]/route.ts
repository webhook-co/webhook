import { listOrgMembers } from "@webhook-co/db/members";
import { avatarR2Key } from "@webhook-co/shared";

import { noAvatarResponse, serveAvatar } from "@/server/avatar-serve";
import { getTenantDb } from "@/server/db";
import { requireOrgAccess } from "@/server/org-access";

export const dynamic = "force-dynamic";

/**
 * A co-member's avatar, for the Team page. Unlike `/api/avatar` (which is session-derived — the caller's own),
 * this serves ANOTHER user's face, so it is doubly gated:
 *   1. `requireOrgAccess(slug)` proves the REQUESTER belongs to the org named in the URL (404s a non-member).
 *   2. the target `userId` must ALSO appear in that org's member directory (co-membership) — otherwise 404,
 *      so this can never be used to fetch the avatar of someone you don't share an org with.
 *
 * The target's provider-avatar URL + email come from the same SECURITY DEFINER directory that already feeds
 * the Team page (`org_member_directory()`), so no extra identity read. Serving itself (R2-first, then the
 * allowlisted provider/Gravatar proxy, forced `image/webp` + `nosniff`, `private`) is the shared `serveAvatar`
 * path — identical to `/api/avatar`.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string; userId: string }> },
): Promise<Response> {
  const { slug, userId } = await ctx.params;
  const access = await requireOrgAccess(slug); // requester must be in this org (404s otherwise)

  const app = await getTenantDb();
  const members = await listOrgMembers(app, access.orgId);
  const target = members.find((m) => m.userId === userId);
  if (!target) return noAvatarResponse(); // not a co-member → reveal nothing

  return serveAvatar({
    r2Key: avatarR2Key(userId),
    image: target.image,
    email: target.email,
  });
}
