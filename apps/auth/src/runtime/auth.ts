// A1b-1 — the Better Auth runtime config + factory for the auth.webhook.co Worker.
//
// This is the RUNTIME instance, distinct from src/auth.ts (the generation-only config that drives the
// schema drift-guard). It serves social login (Google/GitHub) + magic-link only — no password endpoints
// at runtime (the generated schema keeps emailAndPassword on for stability; we just don't serve it).
//
// Two design locks:
//   - HOST-ONLY cookie: no cross-subdomain sharing. The auth.→app. handoff is the backchannel
//     session-exchange (A-SX), not a shared `.webhook.co` cookie (founder X-2).
//   - DB-validated sessions: no cookieCache, so a revoked session dies immediately.
//
// On workerd, env (Hyperdrive connection string, secrets) is only available per-request, so the auth
// instance is built per-request in the route handler via makeAuth(env). Better Auth's adapter takes a
// node-postgres Pool (it does not recognize postgres.js); the Pool is small (Hyperdrive pools upstream).

import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { Pool } from "pg";

import { APP_BASE_URL, MAGIC_LINK_FROM, PROD_AUTH_BASE_URL, type AuthEnv } from "./env";
import { sendMagicLinkEmail } from "./magic-link";

type AuthConfig = Parameters<typeof betterAuth>[0];
type MagicLinkConfig = Parameters<typeof magicLink>[0];

/** A bound email sender: takes the recipient + the verification URL Better Auth generated. */
export type EmailSender = (msg: { to: string; url: string }) => Promise<void>;

export interface AuthConfigDeps {
  /** Better Auth database adapter input (a node-postgres Pool at runtime). */
  database: AuthConfig["database"];
  sendEmail: EmailSender;
}

/**
 * Magic-link plugin options. Single-use links expire in 5 minutes and are stored HASHED (the DB never
 * holds a usable token). The raw token never leaves Better Auth — only the URL reaches the email sender.
 *
 * TODO(A1b deploy / before the endpoint is live): the plugin's built-in rate limiter defaults to
 * IN-MEMORY storage, which is per-isolate on Workers and therefore ineffective across the fleet — a
 * public, email-triggering endpoint must use durable storage (a `rateLimit` DB table or a KV-backed
 * secondaryStorage) + ideally a Turnstile/WAF gate. Deferred to the deploy/bindings slice because the
 * fix needs a KV/DB binding and a deliberate session-storage decision; this endpoint is not yet
 * deployed (apps/auth has no CD). Tracked in ADR-0027 + memory as must-fix-before-live.
 */
export function magicLinkOptions(deps: { sendEmail: EmailSender }): MagicLinkConfig {
  return {
    expiresIn: 300,
    disableSignUp: false,
    storeToken: "hashed",
    sendMagicLink: async ({ email, url }) => {
      await deps.sendEmail({ to: email, url });
    },
  };
}

function resolveBaseUrl(env: AuthEnv): string {
  const baseURL = env.AUTH_BASE_URL ?? PROD_AUTH_BASE_URL;
  // Secure-by-default: Better Auth derives the cookie `Secure` flag + `__Secure-` prefix from the
  // baseURL scheme. Reject a non-loopback http:// origin so a misconfigured env can't silently issue an
  // insecure session cookie. (localhost over http is fine for dev.)
  if (
    baseURL.startsWith("http://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL)
  ) {
    throw new Error("auth baseURL must use https (http:// is only allowed for localhost)");
  }
  return baseURL;
}

/** Build the runtime Better Auth options (pure; no instantiation) — the unit under test. */
export function buildAuthConfig(env: AuthEnv, deps: AuthConfigDeps): AuthConfig {
  const baseURL = resolveBaseUrl(env);
  return {
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    // CSRF origin allow-list: this surface + the app it hands off to.
    trustedOrigins: [baseURL, APP_BASE_URL],
    database: deps.database,
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    plugins: [magicLink(magicLinkOptions(deps))],
    // Explicitly DB-validated sessions: cookieCache off so a revoked session dies immediately (pinned
    // against Better Auth's default of caching for non-stateful instances). Host-only cookie: no
    // `advanced.crossSubDomainCookies` — the auth.→app. handoff is the backchannel session-exchange.
    session: { cookieCache: { enabled: false } },
  };
}

/** A per-request Better Auth runtime + a hook to release its pooled connection after the response. */
export interface RuntimeAuth {
  handler: (request: Request) => Promise<Response>;
  /** End the per-request pg pool (call via ctx.waitUntil) — never leak a pooled connection. */
  close: () => Promise<void>;
}

/** Instantiate the per-request Better Auth runtime from the Worker env. */
export function makeAuth(env: AuthEnv): RuntimeAuth {
  const pool = new Pool({ connectionString: env.HYPERDRIVE_AUTH.connectionString, max: 1 });
  const sendEmail: EmailSender = (msg) =>
    sendMagicLinkEmail({ apiKey: env.RESEND_API_KEY, from: MAGIC_LINK_FROM }, msg);
  const auth = betterAuth(buildAuthConfig(env, { database: pool, sendEmail }));
  return {
    handler: (request) => auth.handler(request),
    close: () => pool.end(),
  };
}
