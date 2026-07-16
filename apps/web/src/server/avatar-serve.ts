import { logActionError } from "@/server/action-log";
import { resolveAvatarSource } from "@/server/avatar";
import { getAvatarBucket } from "@/server/avatar-r2";

// The shared, security-critical avatar SERVE path, used by BOTH `/api/avatar` (the caller's own, session-
// derived) and `/api/org/{slug}/member-avatar/{userId}` (a co-member's, membership-gated). Each route does its
// OWN authorization first, then hands the resolved identity here — so the R2-probe, the allowlist-proxy, and
// the forced `image/webp` + `nosniff` + private-cache headers live in exactly ONE audited place and can't
// drift between the two surfaces.

/**
 * "This person has no avatar" — the NORMAL answer for most users, not an error. 404 (NOT 204): a `<img>` that
 * receives a 204 renders the broken-image glyph in Chrome and never fires `error`, so the initials fallback
 * never runs. A 404 fires `error`, the `<img>` unmounts, and the initials underneath remain.
 *
 * `maxAge` follows the same rule as `serveAvatar`'s, and for the same reason: this 404 is what a first-time
 * uploader's own row is caching, so a long default here strands them behind their own stale absence.
 */
export function noAvatarResponse(maxAge = 60): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": `private, max-age=${maxAge}`, Vary: "Cookie" },
  });
}

/**
 * Serve an avatar for an already-AUTHORIZED identity. Tries the uploaded R2 object first (forced `image/webp`
 * + `nosniff` — the bytes were validated on upload), then the allowlisted provider/Gravatar proxy, else 404.
 * The response is `private` + `Vary: Cookie`: it's one specific person's face resolved from a cookie-gated
 * request, so a shared cache must never serve it across users.
 *
 * `image`/`email` are the identity's provider-avatar URL + email (for the Gravatar fallback). `r2Key` is the
 * deterministic upload key for that identity. This function performs NO authorization — the caller must have
 * already proven the requester may see this identity's avatar.
 */
export async function serveAvatar(input: {
  r2Key: string;
  image: string | null;
  email: string;
  /** Rendered size hint for the upstream fetch (2x is requested for retina). */
  size?: number;
  /**
   * `max-age` (seconds) for EVERY exit below — the uploaded object, the proxied provider image, and the
   * no-avatar 404 alike. Defaults to 60 for `/api/avatar`, whose SSR URL carries no `?v=` — that short window
   * is what makes your own re-upload appear without a hard refresh.
   *
   * It must reach all three or it doesn't do its job. A user's FIRST upload transitions them from the 404 (or
   * from the provider proxy) to an R2 object, so those are exactly the responses a fresh upload has to
   * invalidate. Honouring it on the R2-hit branch alone would only help someone who ALREADY had an uploaded
   * avatar and replaced it — the rarest of the three transitions.
   *
   * A co-member's avatar has no such requirement and pays dearly for the default: the URL is input-less per
   * identity, so a 60s TTL means essentially every Team-page load refetches EVERY member — and each refetch
   * re-runs requireOrgAccess AND a full listOrgMembers before it even reaches R2. Ten members, ten member-list
   * queries, on every refresh. That is the visible delay. Callers serving OTHER people's faces should pass a
   * real TTL; the cost is that their newly-uploaded avatar takes up to that long to appear on your page,
   * which for someone else's face is a fine trade.
   */
  maxAge?: number;
}): Promise<Response> {
  const bucket = await getAvatarBucket();
  if (bucket) {
    try {
      const obj = await bucket.get(input.r2Key);
      if (obj) {
        return new Response(await obj.arrayBuffer(), {
          status: 200,
          headers: {
            "Content-Type": "image/webp",
            "X-Content-Type-Options": "nosniff",
            // See `maxAge`: 60s by default so YOUR own re-upload shows without a hard refresh (the SSR
            // `/api/avatar` URL carries no `?v=`); callers serving someone else's face pass a real TTL.
            "Cache-Control": `private, max-age=${input.maxAge ?? 60}`,
            Vary: "Cookie",
          },
        });
      }
    } catch (error) {
      // R2 hiccup — fall through to the proxied provider image rather than fail the avatar, but record it.
      logActionError("avatar.r2_get", error);
    }
  }

  const source = await resolveAvatarSource({
    image: input.image,
    email: input.email,
    size: input.size ?? 64,
  });
  if (source.kind === "none") return noAvatarResponse(input.maxAge);

  let upstream: Response;
  try {
    // Do not carry cookies to a third party, and do not follow a redirect off the allowlisted host — an open
    // redirect on a provider CDN would otherwise walk straight through the allowlist.
    upstream = await fetch(source.url, { redirect: "manual", headers: { accept: "image/*" } });
  } catch {
    return noAvatarResponse(input.maxAge); // upstream down / DNS / timeout — an avatar must never fail a page
  }
  if (!upstream.ok || !upstream.body) return noAvatarResponse(input.maxAge);

  const contentType = upstream.headers.get("content-type") ?? "";
  // Serve ONLY what an <img> can safely render. `text/html` / `image/svg+xml` would be active content on our
  // OWN ORIGIN — refuse rather than sniff.
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType.split(";")[0]!.trim())) {
    return noAvatarResponse(input.maxAge);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": `private, max-age=${input.maxAge ?? 60}`,
      Vary: "Cookie",
    },
  });
}
