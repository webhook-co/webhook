import { resolveAvatarSource } from "@/server/avatar";
import { verifySession } from "@/server/session";

// Fetches an upstream image per request; never statically optimized.
export const dynamic = "force-dynamic";

/**
 * "This person has no avatar" — the NORMAL answer for most users, not an error condition.
 *
 * 404, and NOT 204, and that is not pedantry. A `<img src>` that receives a 204 does not reliably fire
 * `error` in Chrome: it renders the BROKEN-IMAGE GLYPH and the component's fallback never runs. I shipped 204
 * first, and the account page showed a little torn-picture icon sitting on top of the initials — visible only
 * by opening the page, because jsdom does not load images and no test could see it.
 *
 * A 404 fires `error`, the `<img>` unmounts, and the initials underneath are all that is left.
 *
 * Cached privately all the same: without it, every page view re-asks Gravatar about a user who will never
 * have one.
 */
const NO_AVATAR = () =>
  new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, max-age=3600" },
  });

/**
 * The signed-in user's avatar, proxied.
 *
 * ── This route takes NO INPUT ───────────────────────────────────────────────────────────────────────────
 *
 * No path parameter, no query string, no header. It reads the SESSION, and the session is HMAC-verified. So
 * the URL it fetches is derived entirely from server-held state, and there is nothing for a caller to point
 * it at. That is deliberate, and it is a stronger guarantee than validating an input would be: the classic
 * shape of this bug is an image proxy with a `?url=` parameter, and the classic fix is a blocklist that
 * misses `http://[::1]` or `http://169.254.169.254`. There is no parameter here to get wrong.
 *
 * The upstream host is ALSO allowlisted (`isAllowedProviderAvatar`), because `user.image` is written by code
 * in another app from a third party's profile payload, and "that value is trustworthy" is not an assumption
 * worth building a fetch on.
 *
 * ── Why proxy at all ────────────────────────────────────────────────────────────────────────────────────
 *
 * The CSP is `img-src 'self' data:`, so a Google/GitHub avatar URL cannot render in an `<img>` — the stored
 * `user.image` has never once been displayable. Widening the CSP to admit `googleusercontent.com` and
 * `gravatar.com` would let EVERY page in the product load images from hosts we do not control, to buy one
 * small picture. And a hotlinked Gravatar would beacon the user's IP and referring page to a third party on
 * every page view, keyed by a stable hash of their email — a tracking pixel with a face on it.
 *
 * Here the browser only ever talks to us.
 */
export async function GET(): Promise<Response> {
  // The gate. Also the ONLY source of input: an avatar is a fact about the caller, not a lookup.
  const session = await verifySession();

  const source = await resolveAvatarSource({
    image: session.user.image,
    email: session.user.email,
    size: 64,
  });
  if (source.kind === "none") return NO_AVATAR();

  let upstream: Response;
  try {
    upstream = await fetch(source.url, {
      // Do not carry our cookies to a third party, and do not follow a redirect off the allowlisted host —
      // an open redirect on a provider CDN would otherwise walk straight through the allowlist.
      redirect: "manual",
      headers: { accept: "image/*" },
    });
  } catch {
    // Upstream down, DNS failure, timeout. An avatar is decoration; it must never fail a page.
    return NO_AVATAR();
  }

  // `d=404` means "no Gravatar for this person" — the expected answer for most users, not an error.
  // A 3xx is a redirect we deliberately did not follow (see above), and is treated the same way.
  if (!upstream.ok || !upstream.body) return NO_AVATAR();

  const contentType = upstream.headers.get("content-type") ?? "";
  // Serve ONLY what an <img> can safely render. An upstream that answered `text/html` or `image/svg+xml`
  // would be handing us active content on OUR OWN ORIGIN — SVG carries script, and this response would be
  // same-origin. Refuse rather than sniff.
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType.split(";")[0]!.trim())) {
    return NO_AVATAR();
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // `nosniff` matters even with the check above: it stops the browser second-guessing the type.
      "X-Content-Type-Options": "nosniff",
      // PRIVATE: this is one specific user's face, resolved from their session. A shared/proxy cache must
      // never hand it to the next person through.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
