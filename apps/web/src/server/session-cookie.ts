// ONE definition of the session cookie's identity and attributes, shared by every SET and every DELETE.
//
// This exists because they used to be spelled out separately, and drifted — with a security consequence.
//
// `cookies().delete()` in Next is `set({ ...options, value: "", expires: new Date(0) })`: the caller's
// options are forwarded verbatim onto the clearing header. Logout passed only `{ name, path: "/" }`, so in
// production it emitted
//
//     Set-Cookie: __Host-wh_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT
//
// with no `Secure`. RFC 6265bis §4.1.3 requires a user agent to REJECT a `__Host-`-prefixed cookie that
// lacks `Secure`, so the browser discarded the entire header and the live session cookie was never expired.
// app. is stateless — the signed cookie IS the session, with no server-side revocation store — so that one
// dropped header meant logout revoked NOTHING and the session stayed valid for its full 7-day TTL. It also
// applied to "delete my org" and "delete my account", which cleared the cookie the same way.
//
// The bug was invisible in dev, where the cookie is the unprefixed `wh_session` and the same delete works.
//
// So the name and the attributes are derived TOGETHER, from one place: the `__Host-` prefix and `Secure`
// are not independent choices, and nothing that clears this cookie has to remember to restate them.

/** A cookie's attributes, minus the value/expiry the caller supplies. */
export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
}

function isProd(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

/**
 * The session cookie's name.
 *
 * `__Host-` in production: the browser then guarantees the cookie is host-locked — it cannot have been set
 * by a subdomain, cannot carry a `Domain`, and cannot be scoped to a narrower path. Outside production it is
 * unprefixed, because the prefix REQUIRES `Secure` and dev runs over plain http://localhost.
 */
export function sessionCookieName(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  return isProd(nodeEnv) ? "__Host-wh_session" : "wh_session";
}

/**
 * The attributes for BOTH setting and clearing the session cookie.
 *
 * `secure` is tied to the same condition as the `__Host-` prefix, which is what makes the pair coherent: a
 * prefixed cookie is always Secure, so the clearing header is always accepted. A cookie is matched for
 * replacement by (name, path, domain) — and for a `__Host-` cookie the browser additionally demands Secure
 * on the header doing the clearing. Deleting with these exact options is therefore what actually expires it.
 *
 * No `domain` key is present at all, by design: `__Host-` forbids `Domain`, and app. is a single host.
 */
export function sessionCookieOptions(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: isProd(nodeEnv),
    sameSite: "lax",
    path: "/",
  };
}
