// Org-slug rules, shared by every surface.
//
// The database is the final authority: migration 0069 enforces the format with the `orgs_slug_format` CHECK
// and the reserved-word list with the `org_slug_reserved()` function. But a UI that only learns a slug is
// invalid after a server round-trip is a poor UI, and a server action that lets a bad slug reach the DB just
// to catch a raw constraint error gives the user a worse message than we can. So the SAME rules live here, in
// TypeScript, for live validation and early, friendly rejection.
//
// The one risk of two copies is drift. `packages/db/test/org-slug-parity.test.ts` closes it: it runs every
// word here through the real `org_slug_reserved()` and asserts they agree, and checks the format rules by
// attempting a real INSERT against the actual CHECK. If either side changes without the other, that test goes red.

/**
 * Slugs that would shadow a top-level route segment, a surface, or a brand name. MUST match the SQL
 * `org_slug_reserved` list (migration 0069) — the parity test enforces it.
 */
export const ORG_SLUG_RESERVED: ReadonlySet<string> = new Set([
  // route segments under /org/{slug}/
  "dashboard",
  "endpoints",
  "events",
  "deliveries",
  "destinations",
  "triggers",
  "credentials",
  "settings",
  "team",
  "billing",
  "usage",
  "audit",
  // routing + creation
  "org",
  "orgs",
  "new",
  "api",
  "admin",
  "login",
  "logout",
  "auth",
  "invite",
  // framework / infra
  "static",
  "_next",
  "well-known",
  // brand + surfaces
  "webhook",
  "wbhk",
  "www",
  "app",
  "docs",
  "play",
  "get",
  "status",
  "support",
  "help",
  "pricing",
  "blog",
  "security",
  "legal",
]);

/** The format the DB CHECK enforces: 3–40, lowercase alphanumeric + hyphen, no leading/trailing hyphen. */
const SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export type OrgSlugError = "too_short" | "too_long" | "format" | "all_numeric" | "reserved";
export type OrgSlugValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: OrgSlugError };

/**
 * The ONE user-facing message per slug-validation reason, shared by every surface that rejects a slug — the
 * create-team and rename server actions AND the live client-side hint. Keeping it single-source is the point:
 * an earlier draft had the server and the rename card each carry their own switch, they drifted in wording, and
 * a reason added to one would silently fall through to the other's generic default. One map, no drift.
 */
export function orgSlugErrorMessage(reason: OrgSlugError): string {
  switch (reason) {
    case "too_short":
      return "A URL needs at least 3 characters.";
    case "too_long":
      return "Keep the URL under 40 characters.";
    case "all_numeric":
      return "A URL can't be all numbers.";
    case "reserved":
      return "That word is reserved. Try another.";
    case "format":
      return "Use lowercase letters, numbers, and hyphens (not at the start or end).";
  }
}

/**
 * Validate a slug against the same rules the DB enforces, returning a REASON so a caller can say something
 * specific. Order matters: `reserved` is checked case-insensitively FIRST, so `Dashboard` reads as "that name
 * is reserved" rather than "fix the capitalisation" — the latter would send a user chasing the wrong fix.
 */
export function validateOrgSlug(slug: string): OrgSlugValidation {
  if (ORG_SLUG_RESERVED.has(slug.toLowerCase())) return { ok: false, reason: "reserved" };
  if (slug.length < 3) return { ok: false, reason: "too_short" };
  if (slug.length > 40) return { ok: false, reason: "too_long" };
  if (!SLUG_FORMAT.test(slug)) return { ok: false, reason: "format" };
  if (/^[0-9]+$/.test(slug)) return { ok: false, reason: "all_numeric" };
  return { ok: true };
}

/** The base part of a slug derived from a display name — capped, lowercased, hyphenated. May be "". */
export function slugifyOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/g, ""); // the slice can land on a hyphen
}

/**
 * A GUARANTEED-VALID slug derived from a name, with a RANDOM disambiguating suffix so a collision can be
 * retried by simply calling again.
 *
 * The suffix is always present, so the result is never reserved (a reserved word only ever equals the bare
 * base), never all-numeric (the hyphen + a letter-bearing base break that), and always ≥3 chars — the base
 * falls back to `org` when the name slugifies to nothing.
 *
 * The suffix is 6 CSPRNG hex chars (24 bits), NOT a deterministic hash of the name. That matters: a
 * deterministic suffix makes every concurrent creator of the same display name walk the identical candidate
 * ladder, so they contend for the same rows and can spuriously exhaust a bounded retry loop on a slug space
 * that is nowhere near full. Randomness gives each caller an independent draw — the same reason the personal-
 * org bootstrap salts its own suffix. The caller loops on the DB's live-or-retired unique check, so this need
 * not be stable across calls; each call is a fresh independent candidate.
 */
export function suggestOrgSlug(name: string): string {
  const base = slugifyOrgName(name) || "org";
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); // 6 hex chars
  return `${base}-${suffix}`;
}
