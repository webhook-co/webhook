/**
 * Split a single free-text name into a first/last guess — for providers (GitHub) that give one `name` field
 * rather than separate `given_name`/`family_name`.
 *
 * It is a GUESS, and it is meant to be one. Human names do not decompose reliably ("Ada Lovelace" splits
 * cleanly; "Prince" has no surname; "van der Berg" is one surname that this will mangle) — so the point is not
 * to be right, it is to PRE-FILL. Onboarding shows the user these two fields and lets them fix whatever the
 * split got wrong, which is the whole reason the onboarding screen exists rather than us silently committing a
 * bad guess.
 *
 * Rules, deliberately simple: first token is the first name, everything after it is the last name, and a
 * single token (or nothing) leaves the last name empty rather than duplicating.
 */
export function splitName(name: string | null | undefined): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: undefined, lastName: undefined };
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
