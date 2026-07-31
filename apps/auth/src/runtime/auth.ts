// A1b — the Better Auth runtime config + factory for the auth.webhook.co Worker.
//
// This is the RUNTIME instance, distinct from src/auth.ts (the generation-only config that drives the
// schema drift-guard). It serves social login (Google/GitHub) + magic-link only — no password endpoints
// at runtime (the generated schema keeps emailAndPassword on for stability; we just don't serve it).
//
// Design locks:
//   - HOST-ONLY cookie: no cross-subdomain sharing. The auth.→app. handoff is the backchannel
//     session-exchange (A-SX), not a shared `.webhook.co` cookie (founder X-2).
//   - DB-validated sessions: no cookieCache, so a revoked session dies immediately.
//   - Secrets resolved per-request via readSecretBinding (Secrets Store in prod / strings in dev).
//
// On workerd, env is only available per-request, so the auth instance is built per-request in the route
// handler via makeAuth(env) (async — it resolves the secret bindings first). Better Auth's adapter takes a
// node-postgres Pool (it does not recognize postgres.js); the Pool is small (Hyperdrive pools upstream).

import {
  bootstrapPersonalOrg,
  createClient,
  createCredentialHasherFromBase64,
  stampSignupMilestone,
} from "@webhook-co/db";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { captcha, oneTap } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins/magic-link";
import { Pool } from "pg";

import { splitName } from "@webhook-co/shared";
import { resolveEmailMode } from "@webhook-co/shared/email-transport";

import { withAccountTokenStripping } from "./account-token-hooks";
import { makeBootstrapHooks } from "./bootstrap";
import { isGoogleClientId } from "./google-client-id";
import { emitSignInTelemetry } from "./signin-telemetry";
import { withNameBackfill } from "./name-backfill-hooks";
import {
  APP_BASE_URL,
  AUTH_BASE_PATH,
  MAGIC_LINK_FROM,
  PROD_AUTH_BASE_URL,
  TURNSTILE_ACTION,
  resolveAuthSecrets,
  type AuthEnv,
  type ResolvedAuthSecrets,
} from "./env";
import { makeMagicLinkRateLimit, sendMagicLinkEmail, type MagicLinkRateLimit } from "./magic-link";
import { type RateLimitKv } from "../issuer/rate-limit";

type AuthConfig = Parameters<typeof betterAuth>[0];
type MagicLinkConfig = Parameters<typeof magicLink>[0];

/** A bound email sender: takes the recipient + the verification URL Better Auth generated. */
export type EmailSender = (msg: { to: string; url: string }) => Promise<void>;

export interface AuthConfigInput {
  /** Already resolved + https-guarded (see resolveBaseUrl). */
  baseURL: string;
  secrets: ResolvedAuthSecrets;
}

export interface AuthConfigDeps {
  /** Better Auth database adapter input (a node-postgres Pool at runtime). */
  database: AuthConfig["database"];
  sendEmail: EmailSender;
  /** signup→bootstrap + self-heal hooks (A1b-2). */
  databaseHooks: AuthConfig["databaseHooks"];
  /** Durable magic-link send throttle (makeAuth builds it from RATELIMIT_KV); absent → no extra throttle. */
  rateLimit?: MagicLinkRateLimit;
  /** Structured observability sink (the rate-limit drop is logged; no PII). */
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Magic-link plugin options. Single-use links expire in 5 minutes and are stored HASHED (the DB never
 * holds a usable token). The raw token never leaves Better Auth — only the URL reaches the email sender.
 *
 * Durable send throttle (ADR-0027 must-before-live): Better Auth's built-in limiter is per-isolate
 * in-memory, ineffective fleet-wide for this public, email-triggering endpoint. So the send goes through a
 * durable RATELIMIT_KV throttle (deps.rateLimit, built by makeAuth) keyed by the recipient EMAIL only; when a
 * window is exhausted we SILENTLY skip the send (Better Auth still reports success — no "does this email
 * exist" oracle, and the abuse is bounded). Per-IP / volume limiting lives at the edge/WAF (and the Turnstile
 * gate), not here.
 */
export function magicLinkOptions(deps: {
  sendEmail: EmailSender;
  rateLimit?: MagicLinkRateLimit;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): MagicLinkConfig {
  return {
    expiresIn: 300,
    disableSignUp: false,
    storeToken: "hashed",
    sendMagicLink: async ({ email, url }) => {
      if (deps.rateLimit && !(await deps.rateLimit(email))) {
        deps.log?.("magic_link.rate_limited"); // no PII (the email is the throttled subject)
        return;
      }
      await deps.sendEmail({ to: email, url });
    },
  };
}

/**
 * Resolve + validate the public base URL. Secure-by-default: Better Auth derives the cookie `Secure` flag
 * + `__Secure-` prefix from the scheme, so reject a non-loopback http:// origin (a misconfigured env must
 * not silently issue an insecure session cookie). localhost over http is fine for dev.
 */
export function resolveBaseUrl(authBaseUrl: string | undefined): string {
  const baseURL = authBaseUrl ?? PROD_AUTH_BASE_URL;
  if (
    baseURL.startsWith("http://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL)
  ) {
    throw new Error("auth baseURL must use https (http:// is only allowed for localhost)");
  }
  return baseURL;
}

/**
 * Build the captcha plugins list. Cloudflare Turnstile is defense-in-depth on the public, email-sending
 * magic-link endpoint (it complements, doesn't replace, the durable per-email rate limit). Wired ONLY when
 * the Turnstile secret is configured (prod) so local/test boot without it; it gates EXACTLY the magic-link
 * send (`endpoints` REPLACES the plugin defaults — substring-matched, so social/session stay ungated, and
 * the GET magic-link verify-click is untouched). `allowedHostnames` (the single configured-origin host —
 * prod `auth.webhook.co`, dev `localhost`; so a dev's AUTH_BASE_URL host must match the browser address) is
 * the anti-replay pin; `expectedAction` rejects a token minted for another action on this sitekey. The
 * plugin reads the `x-captcha-response` header the login form sends and siteverifies server-side before
 * Better Auth's handler runs.
 */
function captchaPlugins(baseURL: string, secrets: ResolvedAuthSecrets) {
  if (!secrets.turnstileSecretKey) return [];
  return [
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: secrets.turnstileSecretKey,
      endpoints: ["/sign-in/magic-link"],
      expectedAction: TURNSTILE_ACTION,
      allowedHostnames: [new URL(baseURL).hostname],
    }),
  ];
}

/**
 * Build the Google One Tap plugin list — mounted only when Google is FULLY configured and the resolved
 * client id is actually shaped like one.
 *
 * "Is it mounted" is a security question here, not a feature flag. The plugin exposes a PUBLIC,
 * unauthenticated `POST /one-tap/callback` whose first act on any well-formed input is an outbound fetch
 * to Google's JWKS — reachable by anyone, with a trivially forgeable JWT header. So the endpoint should
 * exist exactly when the feature does and not one deploy longer. Three gates, all of which must hold:
 *
 *   - A client SECRET. Without it the callback can never complete a sign-in, so mounting would leave an
 *     unauthenticated JWKS-fetching endpoint that is guaranteed to fail. Same reasoning as
 *     `socialProviders` refusing a half-configured pair.
 *   - A client id that PASSES `isGoogleClientId`. This is the identical predicate the login page's
 *     browser gate uses (login/one-tap-config.ts), which is the point: the prompt and the endpoint key
 *     off one shared check of one shared secret, so they cannot drift into "prompt with no endpoint" or
 *     "endpoint with no UI that can reach it".
 *   - Both resolved non-empty, which `OAUTH_MODE=optional` makes false for a contributor with no Google
 *     OAuth app — they get no endpoint and no prompt, and sign in by magic link.
 *
 * The audience is pinned EXPLICITLY. The plugin would otherwise fall back to
 * `socialProviders.google.clientId` implicitly (`options?.clientId || googleProvider?.clientId`), which
 * happens to resolve to the same value today. Stating it here is what makes a stolen id token minted for
 * some other Google app useless against us survive a refactor of the social-provider map above.
 *
 * `disableSignup` is deliberately unset: One Tap is prompt-plus-tap-to-confirm WITH signup allowed
 * (founder decision), and the plugin reads `options?.disableSignup || googleProvider?.disableSignUp`, so
 * leaving both unset is the "signups allowed" state.
 *
 * NOT captcha-gated, unlike the magic-link send, and that is considered rather than overlooked: a garbage
 * captcha token would only trade a Google-certs fetch for a Cloudflare siteverify fetch, the login page
 * renders one Turnstile widget whose single-use token the magic-link submit already consumes, and
 * magic-link's actual justification (it emails an attacker-chosen third party) does not transfer here.
 * The abuse ceiling is handled where it belongs — a durable edge throttle in issuer-handler.ts. See
 * ADR-0133; reversing this is a one-line change to the captcha `endpoints` array.
 */
function oneTapPlugins(secrets: ResolvedAuthSecrets) {
  const clientId = secrets.googleClientId;
  if (!secrets.googleClientSecret || !isGoogleClientId(clientId)) return [];
  return [oneTap({ clientId })];
}

/**
 * Build the social-provider map, including only the providers that are FULLY configured.
 *
 * In production both are always configured (readAuthEnv requires all four secrets, and resolveAuthSecrets
 * rejects an empty one), so this returns both and nothing changes. It exists for OAUTH_MODE=optional: a
 * contributor with no Google or GitHub OAuth app boots with neither, and signs in by magic link.
 *
 * A provider is included only when it has BOTH halves. Wiring one with an empty client id or secret would
 * advertise a sign-in route that bounces the user to the provider and fails there — a broken button is
 * worse than an absent one, and a half-set pair is a misconfiguration rather than a hermetic state.
 *
 * Map the provider's given/family name onto our columns. Google returns them directly; GitHub does NOT
 * (it has only a single free-text `name`), so we split on the first space — "Ada Lovelace" -> Ada /
 * Lovelace, "Prince" -> Prince / "". It is a guess, and onboarding lets the user correct it, which is
 * the entire reason onboarding pre-fills rather than assumes. `name` is left to Better Auth's default so
 * the existing composite-name behaviour is unchanged.
 */
function socialProviders(secrets: ResolvedAuthSecrets) {
  const providers: NonNullable<AuthConfig["socialProviders"]> = {};
  if (secrets.googleClientId && secrets.googleClientSecret) {
    providers.google = {
      clientId: secrets.googleClientId,
      clientSecret: secrets.googleClientSecret,
      mapProfileToUser: (profile: { given_name?: string; family_name?: string }) => ({
        firstName: profile.given_name ?? undefined,
        lastName: profile.family_name ?? undefined,
      }),
    };
  }
  if (secrets.githubClientId && secrets.githubClientSecret) {
    providers.github = {
      clientId: secrets.githubClientId,
      clientSecret: secrets.githubClientSecret,
      mapProfileToUser: (profile: { name?: string | null }) => splitName(profile.name),
    };
  }
  return providers;
}

/** Build the runtime Better Auth options (pure; no instantiation) — the unit under test. */
export function buildAuthConfig(input: AuthConfigInput, deps: AuthConfigDeps): AuthConfig {
  const { baseURL, secrets } = input;
  return {
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: secrets.betterAuthSecret,
    // CSRF origin allow-list: this surface + the app it hands off to.
    trustedOrigins: [baseURL, APP_BASE_URL],
    database: deps.database,
    // The runtime must know about the same additionalFields the GENERATOR does (apps/auth/src/auth.ts), or
    // Better Auth silently drops `firstName`/`lastName` on write — the generator config and the runtime config
    // are two separate objects and both have to agree.
    //
    // `firstName`/`lastName` are `input: true` on purpose, and this is load-bearing: `mapProfileToUser`'s
    // output for an OAuth signup is run through the SAME input filter as a client sign-up body
    // (`parseAdditionalUserInputFromProviderProfile` → `parseInputData`), which DROPS any field whose
    // `input` is false. With `input: false` the provider's given/family name never persisted — the columns
    // stayed NULL and the pre-fill below was silently dead. `input: true` is safe here: this runtime is
    // social + magic-link only (no password signup), magic-link's create path writes only email+name, so the
    // sole client-write vector `input: true` opens is `/update-user` letting a signed-in user edit THEIR OWN
    // display name — exactly what the onboarding screen already does. `onboardedAt` STAYS `input: false`: it
    // is the gate flag with trust meaning, written only by the app over the identity RPC, never by a client.
    user: {
      additionalFields: {
        firstName: { type: "string", required: false, input: true },
        lastName: { type: "string", required: false, input: true },
        onboardedAt: { type: "date", required: false, input: false },
        // `input: false` like onboardedAt: the avatar pointer is written ONLY by the app over the identity RPC
        // (after it validated + stored the image in R2), NEVER by a client — a client-settable image key could
        // point the served avatar at someone else's / an arbitrary R2 object.
        imageKey: { type: "string", required: false, input: false },
      },
    },
    socialProviders: socialProviders(secrets),
    // Captcha first (its onRequest gate runs before the magic-link send handler), then magic-link.
    // One Tap mounts its own endpoint and carries no request hooks, so its position is immaterial.
    plugins: [
      ...captchaPlugins(baseURL, secrets),
      ...oneTapPlugins(secrets),
      magicLink(magicLinkOptions(deps)),
    ],
    // Compose the account OAuth-token stripping (data minimization — see account-token-hooks.ts) into the
    // signup→bootstrap hooks here, so EVERY auth instance persists no provider tokens regardless of caller.
    //
    // The name back-fill composes INSIDE the token stripping, so stripping stays the outermost and last
    // word on the account model (it is authoritative and non-negotiable), while the back-fill owns
    // `user.create.before`. Both spread shallowly, so the bootstrap's `user.create.after` — the personal-org
    // provisioning — survives by reference through both wrappers. See name-backfill-hooks.ts for why the
    // back-fill is needed at all: the one-tap plugin bypasses `mapProfileToUser` entirely.
    databaseHooks: withAccountTokenStripping(withNameBackfill(deps.databaseHooks)),
    // Sign-in METHOD telemetry — the one dimension the database cannot recover, because One Tap and the
    // Google button write identical account rows (same providerId, same `sub`). Deliberately a
    // request-level after-hook and not a databaseHook: `user.create.after` and `session.create.after`
    // both carry the bootstrap, so putting telemetry there would mean chaining a load-bearing hook for
    // the sake of a log line. Here the endpoint path arrives on the context directly. Never throws, and
    // emits only `{ method }` — see signin-telemetry.ts.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        await emitSignInTelemetry(deps.log, ctx);
      }),
    },
    advanced: {
      // On Workers the TCP peer is Cloudflare's edge, not the client, so Better Auth's rate limiter must
      // read the trusted client-IP header or it falls back to ONE shared per-path bucket (every caller
      // throttled together — the prod warning). cf-connecting-ip is set by CF and not client-spoofable.
      // No `crossSubDomainCookies` — the cookie stays host-only; the auth.→app. handoff is the backchannel
      // session-exchange.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Origin + callbackURL validation, PINNED rather than inherited — and this one is not a style
      // preference. Better Auth computes `skipOriginCheck` as
      //   `advanced.disableOriginCheck ?? (isTest() ? true : false)`
      // and `isTest()` is `NODE_ENV === "test" || TEST` (@better-auth/core env-impl). So the protection
      // that rejects an untrusted `Origin` AND an off-origin `callbackURL` — the open-redirect guard the
      // one-tap plugin's own schema comment says it depends on — silently disappears the moment either
      // variable is set, with no warning and no failing test. Production does not set them today, so
      // nothing is broken; the point is that nothing *pins* that, and the failure is invisible.
      //
      // It also had a second cost: with the default active under `NODE_ENV=test`, no test in this repo
      // could observe the guard at all. The contract test that asserts an off-origin callbackURL is
      // refused only became possible once this was explicit — the gate was untestable precisely because
      // it was implicitly disabled in exactly the environment where we test.
      disableOriginCheck: false,
    },
    // Explicitly DB-validated sessions: cookieCache off so a revoked session dies immediately (pinned
    // against Better Auth's default of caching for non-stateful instances).
    session: { cookieCache: { enabled: false } },
    // Account linking, PINNED (not riding Better Auth defaults). Linking is a latent account-takeover
    // surface, and an email-change flow is about to lean on it — so the policy is spelled out here rather
    // than inherited. This is behavioural, not schema, so it lives ONLY in the runtime config (unlike
    // `user.additionalFields`, which must also be in the generator to emit columns); the drift guard is
    // unaffected.
    account: {
      accountLinking: {
        // Keep implicit verified-email linking ON (the founder's call): signing in with a provider whose
        // verified email matches an existing account links them, instead of stranding a second identity.
        enabled: true,
        disableImplicitLinking: false,
        // No provider is "trusted" to link WITHOUT a verified incoming email. Empty = the secure default:
        // implicit/explicit linking both require the provider to assert a verified email (google/github do).
        trustedProviders: [],
        // Only ever implicitly link INTO a local account whose own email is verified — blocks the classic
        // pre-hijack (an unverified local account pre-seeded with a victim's email). This is Better Auth's
        // default (`?? true`), pinned here for explicitness + the regression test below.
        // NOTE: this option is @deprecated in better-auth 1.6.23 — it will be removed on the next minor, at
        // which point the gate becomes UNCONDITIONAL (i.e. permanently `true`). So the secure behaviour is
        // guaranteed either way; when the upgrade drops the option, just delete this line (and its assertion
        // in auth.test.ts) — the behaviour does not change. It is NOT a regression.
        requireLocalEmailVerified: true,
        // SAME-EMAIL ONLY, on every path (ADR-0121). A provider can only attach to an account whose email it
        // matches.
        //
        // This flag governs the EXPLICIT /link-social paths alone (better-auth reads it at
        // api/routes/callback.mjs:98 and api/routes/account.mjs:151, plus the generic-oauth plugin we don't
        // install). Implicit sign-in linking never consults it and is same-email by CONSTRUCTION —
        // `findOAuthUser` locates the user BY email, so a match is structural, not configured.
        //
        // It was previously `true`, reserved for "a user who changed their email can re-link their provider".
        // That capability has no surface: there is no UI for /link-social, so the flag only ever widened what
        // a hand-crafted POST could do — enforcing same-email on the path users take while permitting
        // different-email on one they can't reach. Same-email is the policy we want; say so once, here.
        allowDifferentEmails: false,
        // Never let the last sign-in method be unlinked — that would strand the user out of their account.
        allowUnlinkingAll: false,
        // A linked provider must NEVER overwrite the profile the user set here. When true,
        // `applyUpdateUserInfoOnLink` runs on every successful link and does
        // `updateUser(userId, { name, image, ... })` with the PROVIDER's values — so connecting Google would
        // silently replace the display name the user typed on /account/profile. (Their uploaded avatar
        // survives: resolveAvatarSource prefers the R2 image_key over the provider `image`. The name doesn't.)
        //
        // `false` is also Better Auth's current default, so this line changes no behaviour today. It is here
        // because the default is not load-bearing: the regression test's `toEqual` pins THIS OBJECT, so an
        // upstream flip to default-true would clobber profiles with every assertion still green. Pinning it
        // is what makes this block's "PINNED (not riding Better Auth defaults)" claim true of every key.
        updateUserInfoOnLink: false,
      },
    },
  };
}

/** A per-request Better Auth runtime + a hook to release its pooled connection after the response. */
export interface RuntimeAuth {
  handler: (request: Request) => Promise<Response>;
  /**
   * Resolve the live session from the request cookies (DB-validated — cookieCache is off), returning the
   * authenticated `userId` or null. The issuer's `/authorize` + `/consent/decision` (A3) use this to bind
   * consent to the signed-in user; the userId comes from the cookie here, never from the request body.
   */
  getSession: (request: Request) => Promise<{ userId: string } | null>;
  /**
   * End the session at the IdP. DELETES the session row (cookieCache is off, so sessions are DB-validated on
   * every read) and returns Better Auth's clearing `Set-Cookie` — so a copied cookie is dead immediately,
   * rather than relying on the browser to forget it. Used by GET /logout; without it, app. could only clear
   * its own cookie and the auth. session would silently re-mint a new one via /session/handoff.
   */
  signOut: (request: Request) => Promise<Response>;
  /** End the per-request pg pool (call via ctx.waitUntil) — never leak a pooled connection. */
  close: () => Promise<void>;
}

/** The slice of the Cloudflare ExecutionContext we use (waitUntil for the off-hot-path self-heal). */
export interface AuthExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Instantiate the per-request Better Auth runtime from the Worker env (resolves secret bindings first). */
export async function makeAuth(env: AuthEnv, ctx?: AuthExecutionContext): Promise<RuntimeAuth> {
  const secrets = await resolveAuthSecrets(env);
  const baseURL = resolveBaseUrl(env.AUTH_BASE_URL);
  const pool = new Pool({ connectionString: env.HYPERDRIVE_AUTH.connectionString, max: 1 });
  // EMAIL_MODE is resolved (and fenced against the production secret shape) in the shared transport.
  const emailMode = resolveEmailMode(env);
  const sendEmail: EmailSender = (msg) =>
    sendMagicLinkEmail(
      { apiKey: secrets.resendApiKey, from: MAGIC_LINK_FROM, mode: emailMode },
      msg,
    );
  const databaseHooks = makeBootstrapHooks({
    tenantConnectionString: env.HYPERDRIVE_TENANT.connectionString,
    credentialPepper: secrets.credentialPepper,
    createClient,
    bootstrap: bootstrapPersonalOrg,
    stamp: stampSignupMilestone,
    makeHasher: createCredentialHasherFromBase64,
    waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  });
  const log = (event: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message: event, ...fields }));
  // Durable magic-link send throttle — wired when RATELIMIT_KV is bound (always in prod). Absent (e.g. a
  // context without the binding) → no extra throttle, never a crash.
  const rateLimit = env.RATELIMIT_KV
    ? makeMagicLinkRateLimit(env.RATELIMIT_KV as RateLimitKv)
    : undefined;
  const auth = betterAuth(
    buildAuthConfig(
      { baseURL, secrets },
      { database: pool, sendEmail, databaseHooks, rateLimit, log },
    ),
  );
  return {
    handler: (request) => auth.handler(request),
    getSession: async (request) => {
      const result = await auth.api.getSession({ headers: request.headers });
      return result?.user?.id ? { userId: result.user.id } : null;
    },
    // asResponse so we get Better Auth's clearing Set-Cookie verbatim and can forward it onto our redirect.
    // Called through auth.api (not the router) because this is a first-party, same-origin server call — the
    // route's own Sec-Fetch-Site check is the CSRF gate.
    signOut: (request) => auth.api.signOut({ headers: request.headers, asResponse: true }),
    close: () => pool.end(),
  };
}
