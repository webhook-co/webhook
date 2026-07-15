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
 */
export function noAvatarResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, max-age=3600", Vary: "Cookie" },
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
            // Short TTL so a freshly re-uploaded avatar shows within a minute — the URL is input-less per identity.
            "Cache-Control": "private, max-age=60",
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
  if (source.kind === "none") return noAvatarResponse();

  let upstream: Response;
  try {
    // Do not carry cookies to a third party, and do not follow a redirect off the allowlisted host — an open
    // redirect on a provider CDN would otherwise walk straight through the allowlist.
    upstream = await fetch(source.url, { redirect: "manual", headers: { accept: "image/*" } });
  } catch {
    return noAvatarResponse(); // upstream down / DNS / timeout — an avatar must never fail a page
  }
  if (!upstream.ok || !upstream.body) return noAvatarResponse();

  const contentType = upstream.headers.get("content-type") ?? "";
  // Serve ONLY what an <img> can safely render. `text/html` / `image/svg+xml` would be active content on our
  // OWN ORIGIN — refuse rather than sniff.
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType.split(";")[0]!.trim())) {
    return noAvatarResponse();
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
      Vary: "Cookie",
    },
  });
}
