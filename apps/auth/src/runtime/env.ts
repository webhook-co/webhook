// A1b — the auth Worker's runtime bindings + secrets, accessed per-request via getCloudflareContext()
// (env is not available at module load on workerd). Secrets are Cloudflare Secrets Store bindings in prod
// and plain strings in dev/test; `readSecretBinding` handles both, so the runtime resolves them the same
// way regardless of source. Hyperdrive is typed structurally (just the connectionString we use).

import { readSecretBinding } from "@webhook-co/shared";

export interface HyperdriveBinding {
  /** The PostgreSQL connection URI Hyperdrive proxies (verify-full to Neon). */
  connectionString: string;
}

/** A secret value: a Secrets Store binding (prod) or a plain string (dev/test) — readSecretBinding's input. */
type Secret = Parameters<typeof readSecretBinding>[0];

export interface AuthEnv {
  /**
   * Better Auth's identity-table CRUD connects as the **webhook_auth** role (migration 0016: DML on
   * user/session/account/verification). DISTINCT from the repo's `HYPERDRIVE_AUTHN` (webhook_authn
   * bearer-verify, SELECT-only) — do NOT reuse that; webhook_app is also ungranted on the identity tables.
   */
  HYPERDRIVE_AUTH: HyperdriveBinding;
  /** webhook_app role — the personal-org bootstrap path (A1b-2), a separate driver/role. */
  HYPERDRIVE_TENANT: HyperdriveBinding;
  BETTER_AUTH_SECRET: Secret;
  /** Base64 credential pepper — keys the bootstrap's default-endpoint ingest-token HMAC. */
  CREDENTIAL_PEPPER: Secret;
  /** Public origin of this auth surface; defaults to the prod host. */
  AUTH_BASE_URL?: string;
  GOOGLE_CLIENT_ID: Secret;
  GOOGLE_CLIENT_SECRET: Secret;
  GITHUB_CLIENT_ID: Secret;
  GITHUB_CLIENT_SECRET: Secret;
  RESEND_API_KEY: Secret;
}

/** Secrets resolved to plain strings (Better Auth + the hasher take strings). */
export interface ResolvedAuthSecrets {
  betterAuthSecret: string;
  credentialPepper: string;
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  resendApiKey: string;
}

const REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET",
  "CREDENTIAL_PEPPER",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
] as const;

const REQUIRED_BINDINGS = ["HYPERDRIVE_AUTH", "HYPERDRIVE_TENANT"] as const;

/** A secret is present if it's a non-empty string or a Secrets Store binding (an object with `.get()`). */
function secretPresent(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return typeof (value as { get?: unknown } | null)?.get === "function";
}

/**
 * Validate the Worker env at the request boundary and narrow it to AuthEnv. Fails closed with a clear
 * message (naming the missing key, never its value) on any absent/empty secret or mis-named/malformed
 * Hyperdrive binding — so a misconfig surfaces as an obvious 500 on the first request rather than an
 * empty-secret session signer or an `undefined.connectionString`/`undefined.get()` crash downstream.
 */
export function readAuthEnv(env: Record<string, unknown>): AuthEnv {
  for (const key of REQUIRED_SECRETS) {
    if (!secretPresent(env[key])) {
      throw new Error(`auth env: missing or empty required secret ${key}`);
    }
  }
  for (const key of REQUIRED_BINDINGS) {
    const binding = env[key] as HyperdriveBinding | undefined;
    if (
      !binding ||
      typeof binding.connectionString !== "string" ||
      binding.connectionString.length === 0
    ) {
      throw new Error(`auth env: missing or malformed Hyperdrive binding ${key}`);
    }
  }
  return env as unknown as AuthEnv;
}

/** Resolve every secret to a plain string (Secrets Store `.get()` or pass-through), in parallel. */
export async function resolveAuthSecrets(env: AuthEnv): Promise<ResolvedAuthSecrets> {
  const [
    betterAuthSecret,
    credentialPepper,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    resendApiKey,
  ] = await Promise.all([
    readSecretBinding(env.BETTER_AUTH_SECRET),
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.GOOGLE_CLIENT_ID),
    readSecretBinding(env.GOOGLE_CLIENT_SECRET),
    readSecretBinding(env.GITHUB_CLIENT_ID),
    readSecretBinding(env.GITHUB_CLIENT_SECRET),
    readSecretBinding(env.RESEND_API_KEY),
  ]);
  const resolved = {
    betterAuthSecret,
    credentialPepper,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    resendApiKey,
  };
  // Fail closed on an EMPTY resolved value — readAuthEnv can't see inside a Secrets Store binding, so a
  // mis-provisioned (empty) store secret only surfaces here. Never sign sessions / mint with an empty key.
  for (const [name, value] of Object.entries(resolved)) {
    if (value.length === 0) throw new Error(`auth env: resolved secret ${name} is empty`);
  }
  return resolved;
}

export const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
export const APP_BASE_URL = "https://app.webhook.co";
/** The verified Resend sender (mail.webhook.co; tracking off — see magic-link.ts). */
export const MAGIC_LINK_FROM = "login@mail.webhook.co";
