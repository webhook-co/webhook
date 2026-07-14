/**
 * Split a single free-text name into a first/last GUESS — for providers (GitHub) that give one `name` field
 * rather than separate `given_name`/`family_name`, and for a magic-link user with only a composite name.
 *
 * It is a GUESS, and it is meant to be one. Human names do not decompose reliably ("Ada Lovelace" splits
 * cleanly; "Prince" has no surname; "van der Berg" is one surname this will mangle) — the point is not to be
 * right, it is to PRE-FILL. Onboarding shows the user these two fields and lets them fix whatever the split got
 * wrong, which is the whole reason the onboarding screen exists rather than us committing a bad guess.
 *
 * Rules, deliberately simple: first token is the first name, everything after it is the last name, and a
 * single token (or nothing) leaves the last name empty rather than duplicating. Empties come back `undefined`
 * (not ""), so an OAuth create does not write blank strings; a caller that needs strings coerces with `?? ""`.
 *
 * This is the ONE copy — both the auth provider mapping and the web onboarding pre-fill call it, so the
 * heuristic can only improve in one place.
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
