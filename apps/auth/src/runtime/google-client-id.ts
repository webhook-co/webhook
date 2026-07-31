// The shape of a Google OAuth client id — the ONE predicate that both One Tap gates consult.
//
// Dependency-free on purpose, the same reason `turnstile-sitekey.ts` is: it is imported from a
// `"use client"`-adjacent server component (login/one-tap-config.ts) AND from the Worker runtime
// (runtime/auth.ts), so it must pull in neither `server-only` nor the Cloudflare context.
//
// Two call sites, one predicate, and that is the point. The browser gate (does the login page render
// the prompt?) and the server gate (is the /one-tap/callback endpoint mounted?) key off the same
// resolved secret through the same check, so they cannot land in a state where the prompt is offered
// but the endpoint is absent, or the endpoint is exposed with no UI that can reach it. Two predicates
// would eventually disagree; one cannot.

/**
 * Whether a value is shaped like a Google OAuth client id.
 *
 * This is a MIS-PROVISIONING guard, not a security boundary — Google itself rejects a wrong audience,
 * and this check is worthless against an attacker who controls the config. It earns its place against
 * one specific, plausible deploy fault: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` sit on adjacent
 * lines in every config file this repo has, and swapping them would render the CLIENT SECRET into an
 * HTML attribute on a public, signed-out page for every visitor. Google client secrets carry a
 * `GOCSPX-` prefix and can never match this pattern, so one regex converts a credential disclosure
 * into "One Tap quietly does not appear".
 *
 * Both live formats are accepted: the current `<project-number>-<random>.apps.googleusercontent.com`
 * and the legacy suffix-less `<project-number>.apps.googleusercontent.com`.
 *
 * Anchored at BOTH ends with no `\s` tolerance, so a value carrying a trailing newline and a second
 * smuggled token is rejected rather than silently truncated — callers trim first and pass the exact
 * string they intend to use. Over-strictness has a real cost (a valid id that fails here means One Tap
 * never renders, with no user-visible signal), which is why the caller logs a rejection of a non-empty
 * value instead of swallowing it.
 */
export function isGoogleClientId(value: string): boolean {
  return /^\d+(-[a-z0-9]+)?\.apps\.googleusercontent\.com$/.test(value);
}
