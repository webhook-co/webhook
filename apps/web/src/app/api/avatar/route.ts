import { avatarR2Key } from "@webhook-co/shared";

import { resolveAvatarSource } from "@/server/avatar";
import { getAvatarBucket } from "@/server/avatar-r2";
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
    headers: { "Cache-Control": "private, max-age=3600", Vary: "Cookie" },
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

  // An UPLOADED avatar wins over the proxied provider image. The key is derived from the (verified) session
  // userId — no input, no DB read; the bucket is private (Worker-binding only), so no other user's object is
  // reachable. The stored bytes were validated to be webp on upload, so we FORCE `image/webp` + `nosniff`
  // (never echo/sniff) — a surprise body can never be active content on our origin.
  const bucket = await getAvatarBucket();
  if (bucket) {
    try {
      const obj = await bucket.get(avatarR2Key(session.userId));
      if (obj) {
        return new Response(await obj.arrayBuffer(), {
          status: 200,
          headers: {
            "Content-Type": "image/webp",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
            Vary: "Cookie",
          },
        });
      }
    } catch {
      // R2 hiccup — fall through to the proxied provider image rather than fail the avatar.
    }
  }

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
      // Echoed from upstream, but only AFTER the check above — and `new Headers()` rejects a CR/LF, so a
      // header-splitting payload cannot ride out of here in any case.
      "Content-Type": contentType,
      // `nosniff` matters even with the check above: it stops the browser second-guessing the type.
      "X-Content-Type-Options": "nosniff",
      // The URL is a CONSTANT — `/api/avatar`, no parameters — and the response is ONE SPECIFIC PERSON'S FACE,
      // resolved from their cookie. That is the exact shape a shared cache gets wrong: same key, different
      // answers, and the difference lives in a header.
      //
      // `private` is the instruction ("browser only, never a shared cache"), and `Vary: Cookie` is the belt to
      // its braces: it tells any cache that DOES store this that the response is a function of the cookie, so
      // two users cannot collide on the key even if `private` were ignored. Neither is expensive, and serving
      // one customer's photograph to another is not a mistake you get to make twice.
      "Cache-Control": "private, max-age=3600",
      Vary: "Cookie",
    },
  });
}
