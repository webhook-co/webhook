// Which sign-in method a completed sign-in used — the one dimension the database cannot recover.
//
// WHY THIS EXISTS. One Tap and the "Continue with Google" button produce IDENTICAL rows: both write
// `providerId: "google"` with the same Google `sub` on the same account model. So after shipping One Tap
// there is no query that answers "is anyone actually using it", which makes the feature unfalsifiable —
// it can neither be justified nor retired on evidence. This emits the missing dimension, and nothing else.
//
// WHY AN ENDPOINT AFTER-HOOK AND NOT A `databaseHooks` HOOK. The natural-looking seams are already taken
// and taking them would cost something real: `user.create.after` and `session.create.after` both carry
// the bootstrap (personal-org provisioning and its self-heal), so telemetry there would have to CHAIN,
// which trades a load-bearing hook's identity for a log line. The request-level `hooks.after` has neither
// problem and is strictly better suited: it runs once per request, and better-auth's dispatch stamps
// `path: endpoint.path` on the context, so the endpoint that completed the sign-in is read directly
// rather than inferred.
//
// WHAT IT DELIBERATELY DOES NOT EMIT. The plan asked for an `isSignup` flag alongside the method. There
// is no exact signal for it at this layer — only heuristics like "was the user row created in the last
// few seconds" — and a heuristic in telemetry is worse than a gap, because the number looks authoritative
// and gets trusted. It is also unnecessary: the bootstrap already stamps a signup milestone on the new
// org (with utm first-touch attribution), so signup VOLUME is measured. What was missing was the METHOD,
// which this now records for every sign-in, the first one included. Counting signups per method is a join
// of two things that both exist, rather than a third number that might be wrong.

import { ONE_TAP_CALLBACK_PATH } from "./urls";

/** The sign-in methods this app can complete a sign-in through. */
export type SignInMethod = "one_tap" | "social" | "magic_link";

/**
 * Registered better-auth endpoint paths that COMPLETE a sign-in, mapped to the method they represent.
 *
 * Read off the installed package's `createAuthEndpoint` calls, not from documentation. Two details are
 * load-bearing and easy to get wrong:
 *
 *   - The keys are the REGISTERED paths, basePath stripped, and for the OAuth callback that means the
 *     PATTERN `/callback/:id` rather than a concrete `/callback/google`. better-auth's dispatch sets
 *     `path: endpoint.path`, so a concrete string here would simply never match in production.
 *   - Only sign-in-COMPLETING endpoints belong here. `/sign-in/social` merely redirects to the provider
 *     and `/sign-in/magic-link` merely sends an email; counting either would count intents as sign-ins.
 *
 * A renamed upstream path fails soft — the method goes uncounted rather than counted wrongly — which is
 * the right direction for telemetry, but is exactly why the map is pinned by a test.
 */
export const SIGNIN_METHOD_BY_PATH: Readonly<Record<string, SignInMethod>> = {
  [ONE_TAP_CALLBACK_PATH]: "one_tap",
  "/callback/:id": "social",
  "/magic-link/verify": "magic_link",
};

/** The method a registered endpoint path represents, or undefined if it completes no sign-in. Total. */
export function signInMethodForPath(path: unknown): SignInMethod | undefined {
  return typeof path === "string" ? SIGNIN_METHOD_BY_PATH[path] : undefined;
}

/** The structured observability sink `buildAuthConfig` threads through (`deps.log`). */
type LogSink = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Emit `signin.method` when — and only when — this request actually established a session.
 *
 * The `newSession` guard is what separates a sign-in from an ATTEMPT. better-auth sets
 * `context.newSession` in `setSessionCookie`, and the anonymous and multi-session plugins read it the
 * same way; without it this fires on every request to a matched path including rejected ones, and a
 * failed One Tap token would be recorded as a successful One Tap sign-in.
 *
 * The payload is `{ method }` and nothing else. The context in scope holds the user's email, name, image
 * and id, so the event is built by naming the one field it may carry rather than by removing fields —
 * PII-free by construction, and pinned by a test that asserts the exact key set.
 *
 * Total by construction: this runs INSIDE the sign-in request, so a telemetry fault must never cost a
 * user their session. Every failure — a malformed context, a missing sink, a throwing sink — resolves to
 * "emit nothing".
 */
export async function emitSignInTelemetry(
  log: LogSink | undefined,
  context: unknown,
): Promise<void> {
  try {
    if (log === undefined) return;
    if (typeof context !== "object" || context === null) return;

    const { path, context: authContext } = context as { path?: unknown; context?: unknown };
    const method = signInMethodForPath(path);
    if (method === undefined) return;

    // No session established → this was an attempt, not a sign-in.
    const newSession = (authContext as { newSession?: unknown } | undefined)?.newSession;
    if (newSession === null || newSession === undefined) return;

    log("signin.method", { method });
  } catch {
    // A sign-in must never fail because its telemetry did.
  }
}
