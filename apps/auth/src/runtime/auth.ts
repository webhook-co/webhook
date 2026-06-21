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
} from "@webhook-co/db";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { Pool } from "pg";

import { makeBootstrapHooks } from "./bootstrap";
import {
  APP_BASE_URL,
  MAGIC_LINK_FROM,
  PROD_AUTH_BASE_URL,
  resolveAuthSecrets,
  type AuthEnv,
  type ResolvedAuthSecrets,
} from "./env";
import { sendMagicLinkEmail } from "./magic-link";

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
}

/**
 * Magic-link plugin options. Single-use links expire in 5 minutes and are stored HASHED (the DB never
 * holds a usable token). The raw token never leaves Better Auth — only the URL reaches the email sender.
 *
 * TODO(deploy / before the endpoint is live): the plugin's built-in rate limiter defaults to IN-MEMORY
 * storage, which is per-isolate on Workers and ineffective fleet-wide — a public, email-triggering endpoint
 * must use durable storage (a `rateLimit` DB table or a KV-backed secondaryStorage) + ideally a
 * Turnstile/WAF gate. Deferred to the deploy/bindings slice (needs a KV/DB binding + a session-storage
 * decision; the endpoint is not yet deployed). Tracked in ADR-0027 as must-fix-before-live.
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

/** Build the runtime Better Auth options (pure; no instantiation) — the unit under test. */
export function buildAuthConfig(input: AuthConfigInput, deps: AuthConfigDeps): AuthConfig {
  const { baseURL, secrets } = input;
  return {
    baseURL,
    basePath: "/api/auth",
    secret: secrets.betterAuthSecret,
    // CSRF origin allow-list: this surface + the app it hands off to.
    trustedOrigins: [baseURL, APP_BASE_URL],
    database: deps.database,
    socialProviders: {
      google: { clientId: secrets.googleClientId, clientSecret: secrets.googleClientSecret },
      github: { clientId: secrets.githubClientId, clientSecret: secrets.githubClientSecret },
    },
    plugins: [magicLink(magicLinkOptions(deps))],
    databaseHooks: deps.databaseHooks,
    // Explicitly DB-validated sessions: cookieCache off so a revoked session dies immediately (pinned
    // against Better Auth's default of caching for non-stateful instances). Host-only cookie: no
    // `advanced.crossSubDomainCookies` — the auth.→app. handoff is the backchannel session-exchange.
    session: { cookieCache: { enabled: false } },
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
  const sendEmail: EmailSender = (msg) =>
    sendMagicLinkEmail({ apiKey: secrets.resendApiKey, from: MAGIC_LINK_FROM }, msg);
  const databaseHooks = makeBootstrapHooks({
    tenantConnectionString: env.HYPERDRIVE_TENANT.connectionString,
    credentialPepper: secrets.credentialPepper,
    createClient,
    bootstrap: bootstrapPersonalOrg,
    makeHasher: createCredentialHasherFromBase64,
    waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  });
  const auth = betterAuth(
    buildAuthConfig({ baseURL, secrets }, { database: pool, sendEmail, databaseHooks }),
  );
  return {
    handler: (request) => auth.handler(request),
    getSession: async (request) => {
      const result = await auth.api.getSession({ headers: request.headers });
      return result?.user?.id ? { userId: result.user.id } : null;
    },
    close: () => pool.end(),
  };
}
