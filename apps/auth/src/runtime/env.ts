// A1b-1 — the auth Worker's runtime bindings + secrets, accessed per-request via
// getCloudflareContext() (env is not available at module load on workerd). Hyperdrive is typed
// structurally (just the connectionString we use) to avoid a workers-types dependency here.

export interface HyperdriveBinding {
  /** The PostgreSQL connection URI Hyperdrive proxies (verify-full to Neon). */
  connectionString: string;
}

export interface AuthEnv {
  /**
   * Better Auth's identity-table CRUD connects as the **webhook_auth** role (migration 0016: DML on
   * user/session/account/verification). NOTE this is DISTINCT from the repo's existing `HYPERDRIVE_AUTHN`
   * binding, which is the webhook_authn bearer-verify role (SELECT-only on api_keys) — do NOT reuse that
   * here; webhook_app is also ungranted on the identity tables. Its prod Hyperdrive (webhook-prod-auth)
   * is provisioned at deploy.
   */
  HYPERDRIVE_AUTH: HyperdriveBinding;
  /** webhook_app role — the personal-org bootstrap path (A1b-2), a separate driver/role. */
  HYPERDRIVE_TENANT: HyperdriveBinding;
  /** Better Auth signing secret (Secrets Store). */
  BETTER_AUTH_SECRET: string;
  /** Public origin of this auth surface; defaults to the prod host. */
  AUTH_BASE_URL?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Resend API key for the magic-link email. */
  RESEND_API_KEY: string;
}

const REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
] as const;

const REQUIRED_BINDINGS = ["HYPERDRIVE_AUTH", "HYPERDRIVE_TENANT"] as const;

/**
 * Validate the Worker env at the request boundary and narrow it to AuthEnv. Fails closed with a clear
 * message (naming the missing key, never its value) on any absent/empty secret or mis-named/malformed
 * Hyperdrive binding — so a misconfig surfaces as an obvious 500 on the first request rather than an
 * empty-secret session signer or an `undefined.connectionString` crash.
 */
export function readAuthEnv(env: Record<string, unknown>): AuthEnv {
  for (const key of REQUIRED_SECRETS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) {
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

export const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
export const APP_BASE_URL = "https://app.webhook.co";
/** The verified Resend sender (mail.webhook.co; tracking off — see magic-link.ts). */
export const MAGIC_LINK_FROM = "login@mail.webhook.co";
