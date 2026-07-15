import { orgLogoR2Key } from "@webhook-co/shared";

import { logActionError } from "@/server/action-log";
import { getAvatarBucket } from "@/server/avatar-r2";
import { requireOrgAccess } from "@/server/org-access";

export const dynamic = "force-dynamic";

/**
 * An organization's logo, served from R2.
 *
 * Gated by `requireOrgAccess(slug)` — it 404s a non-member, so this only ever serves the logo to a member of
 * the org named in the URL, and the org id is the RESOLVED one (from the caller's directory), never the raw
 * URL segment. Unlike the user-avatar route there is NO provider/Gravatar fallback: an org has only the one
 * uploaded logo, and its absence is the normal case (→ the generated `OrgAvatar` renders instead).
 *
 * The stored bytes were validated to be webp on upload, so we FORCE `image/webp` + `nosniff` (never sniff a
 * surprise body into active content on our own origin). Cached `private` + `Vary: Cookie`: the same logo is
 * shown to every member, but access is cookie-gated, so a shared cache must not serve it — or the 404 for a
 * non-member — across the membership boundary.
 */
const NO_LOGO = () =>
  new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, max-age=60", Vary: "Cookie" },
  });

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const access = await requireOrgAccess(slug); // 404s a non-member before any R2 access

  const bucket = await getAvatarBucket();
  if (!bucket) return NO_LOGO(); // unbound in dev / non-workerd

  try {
    const obj = await bucket.get(orgLogoR2Key(access.orgId));
    if (!obj) return NO_LOGO();
    return new Response(await obj.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "X-Content-Type-Options": "nosniff",
        // Short TTL so a freshly re-uploaded logo shows within a minute — the URL is input-less per org.
        "Cache-Control": "private, max-age=60",
        Vary: "Cookie",
      },
    });
  } catch (error) {
    // R2 hiccup — never fail the page over decoration; fall back to the generated avatar, but record it.
    logActionError("org_logo.r2_get", error);
    return NO_LOGO();
  }
}
