import "server-only";

/**
 * Where a user's avatar actually comes from — the pure decision, with no I/O, so it can be tested directly.
 *
 * ── Why a proxy exists at all ───────────────────────────────────────────────────────────────────────────
 *
 * The dashboard's CSP is `img-src 'self' data:`. So a Google or GitHub avatar URL in an `<img>` is BLOCKED —
 * `session.user.image` has been stored on every OAuth signup and has never once been renderable. That is why
 * the account menu draws initials.
 *
 * We are not widening `img-src`. Adding `lh3.googleusercontent.com` and `gravatar.com` to the CSP would let
 * every page in the product load images from hosts we do not control, to buy one small picture. Instead the
 * browser only ever talks to US, and the server fetches upstream — which also means Gravatar never sees the
 * user's IP, and never learns which of our pages they are on.
 *
 * ── Why Gravatar is proxied and not hotlinked ───────────────────────────────────────────────────────────
 *
 * A hotlinked `gravatar.com/avatar/<hash>` beacons the user's IP, user-agent and referring page to a third
 * party on every single page view, keyed by a stable hash of their email — which is a durable cross-site
 * identifier. That is a tracking pixel with a face on it. Proxying keeps the request server-side.
 *
 * ── SSRF: the allowlist is the whole defence ────────────────────────────────────────────────────────────
 *
 * An image proxy that fetches a URL taken from data is an SSRF primitive: point it at `http://127.0.0.1:…`
 * or the cloud metadata endpoint and it will happily fetch and return the bytes. `user.image` is written by
 * Better Auth from the OAuth provider's profile, so it is not directly attacker-controlled — but "not
 * currently attacker-controlled" is a property of code somewhere else, and this module should not depend on
 * it. So the host is checked against a fixed allowlist and the scheme must be https. Anything else falls
 * through to Gravatar, and Gravatar's host is a constant.
 */

/**
 * The only hosts we will fetch a provider avatar from. EXACT match — not a suffix, so `evil-lh3…` and
 * `lh3.googleusercontent.com.evil.test` are both out.
 *
 * Google shards avatars across `lh3`–`lh6`, so all four are listed — otherwise a user whose picture happens
 * to live on `lh5` silently falls through to Gravatar. (An earlier comment claimed "subdomain of a listed
 * suffix", which the code never did; the honest fix is to enumerate the real hosts, not to loosen the match.)
 */
const PROVIDER_AVATAR_HOSTS: readonly string[] = [
  "lh3.googleusercontent.com", // Google
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
  "avatars.githubusercontent.com", // GitHub
];

const GRAVATAR_HOST = "gravatar.com";

export type AvatarSource =
  | { readonly kind: "provider"; readonly url: string }
  | { readonly kind: "gravatar"; readonly url: string }
  | { readonly kind: "none" };

/**
 * If this is a provider avatar URL we are willing to fetch, return the RE-SERIALIZED URL; otherwise null.
 *
 * Returning `url.href` rather than a boolean is deliberate. The caller must fetch EXACTLY what was validated —
 * the parsed, canonicalized form — never the raw input string. Validating one string and fetching another is
 * the classic parser-differential SSRF: it is safe here only because `fetch` happens to use the same WHATWG
 * parser, and "happens to" is not something a security boundary should rest on. Hand the caller the canonical
 * URL and the gap cannot exist.
 */
export function allowedProviderAvatarUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // http:// is refused even for an allowlisted host: it would let a network-position attacker swap the bytes,
  // and there is no reason for a provider CDN to be served over anything but https.
  if (url.protocol !== "https:") return null;
  return PROVIDER_AVATAR_HOSTS.includes(url.hostname) ? url.href : null;
}

/** Boolean convenience over {@link allowedProviderAvatarUrl}, for tests and readability. */
export function isAllowedProviderAvatar(raw: string): boolean {
  return allowedProviderAvatarUrl(raw) !== null;
}

/**
 * Gravatar's identifier is a hash of the lowercased, trimmed email.
 *
 * SHA-256, not MD5. Gravatar accepts both; MD5 is the legacy form and there is no reason to reach for a
 * broken hash when the modern one is supported and is one line of Web Crypto.
 */
export async function gravatarHash(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AvatarInput {
  /** `user.image` from the session — the OAuth provider's avatar URL, if the provider gave one. */
  readonly image: string | null;
  readonly email: string;
  /** Rendered size in CSS pixels; the upstream is asked for 2x so it stays sharp on a retina display. */
  readonly size: number;
}

/**
 * Resolve where to fetch the avatar from.
 *
 * `d=404` on the Gravatar URL is doing real work: WITHOUT it Gravatar returns a generated fallback (a
 * "mystery person" silhouette) with a 200, and we would proudly proxy a grey blob for every user who has
 * never heard of Gravatar — which is most of them. With `d=404` a user who has no Gravatar produces a clean
 * 404, we serve nothing, and the UI falls back to their initials, which are at least about them.
 */
export async function resolveAvatarSource(input: AvatarInput): Promise<AvatarSource> {
  // The CANONICAL url, not the raw input — the route fetches exactly this, so there is no validated-one /
  // fetched-another gap to worry about.
  const provider = input.image ? allowedProviderAvatarUrl(input.image) : null;
  if (provider) return { kind: "provider", url: provider };
  if (!input.email.includes("@")) return { kind: "none" };

  const hash = await gravatarHash(input.email);
  const size = Math.min(Math.max(input.size, 16), 512) * 2;
  return {
    kind: "gravatar",
    url: `https://${GRAVATAR_HOST}/avatar/${hash}?s=${size}&d=404`,
  };
}
