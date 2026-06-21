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
// --- A2b-2b: the frozen /token route's env slice ---------------------------------------------------
// Distinct from AuthEnv so the issuer endpoint doesn't drag the better-auth runtime's secrets
// (Google/GitHub/Resend) into its failure surface and vice-versa. /token mints scoped keys + refresh
// handles as webhook_app, so it needs the tenant Hyperdrive, the credential pepper (key/refresh hash),
// the audit-chain HMAC key (the aae1 mint audit), and OAUTH_KV (the provider store getOAuthApi reads to
// unwrap/revoke the opaque grant).
export interface TokenEnv {
  HYPERDRIVE_TENANT: HyperdriveBinding;
  CREDENTIAL_PEPPER: Secret;
  AUDIT_CHAIN_HMAC_KEY: Secret;
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env) reads it per request. */
  OAUTH_KV: unknown;
}

/**
 * Validate + narrow the env for the /token route, fail-closed (naming the missing key, never its value):
 * a misconfig surfaces as an obvious 500 on the first /token request rather than a downstream crash.
 */
export function readTokenEnv(env: Record<string, unknown>): TokenEnv {
  for (const key of ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY"] as const) {
    if (!secretPresent(env[key])) {
      throw new Error(`token env: missing or empty required secret ${key}`);
    }
  }
  const tenant = env.HYPERDRIVE_TENANT as HyperdriveBinding | undefined;
  if (
    !tenant ||
    typeof tenant.connectionString !== "string" ||
    tenant.connectionString.length === 0
  ) {
    throw new Error("token env: missing or malformed Hyperdrive binding HYPERDRIVE_TENANT");
  }
  if (env.OAUTH_KV == null || typeof env.OAUTH_KV !== "object") {
    throw new Error("token env: missing OAUTH_KV binding");
  }
  return env as unknown as TokenEnv;
}

// --- A2b-4b: the frozen /revoke route's env slice --------------------------------------------------
// /revoke resolves a presented token to its grant cross-org then revokes it: a whk_ access key needs the
// bearer-verify Hyperdrive (webhook_authn, cross-org by-hash); an rtk_ refresh handle + the grant cascade
// run as webhook_app (HYPERDRIVE_TENANT); the pepper hashes the presented token; the audit key signs the
// grant_revoked entry; KV_AUTHZ is the cross-surface principal cache evicted on revoke.
export interface RevokeEnv {
  HYPERDRIVE_AUTHN: HyperdriveBinding;
  HYPERDRIVE_TENANT: HyperdriveBinding;
  CREDENTIAL_PEPPER: Secret;
  AUDIT_CHAIN_HMAC_KEY: Secret;
  /** The cross-surface principal cache (KVNamespace) api./mcp./engine share — evicted by key hash. */
  KV_AUTHZ: unknown;
}

/**
 * Validate + narrow the env for the /revoke route, fail-closed (naming the missing key, never its value).
 */
export function readRevokeEnv(env: Record<string, unknown>): RevokeEnv {
  for (const key of ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY"] as const) {
    if (!secretPresent(env[key])) {
      throw new Error(`revoke env: missing or empty required secret ${key}`);
    }
  }
  for (const key of ["HYPERDRIVE_AUTHN", "HYPERDRIVE_TENANT"] as const) {
    const binding = env[key] as HyperdriveBinding | undefined;
    if (
      !binding ||
      typeof binding.connectionString !== "string" ||
      binding.connectionString.length === 0
    ) {
      throw new Error(`revoke env: missing or malformed Hyperdrive binding ${key}`);
    }
  }
  if (env.KV_AUTHZ == null || typeof env.KV_AUTHZ !== "object") {
    throw new Error("revoke env: missing KV_AUTHZ binding");
  }
  return env as unknown as RevokeEnv;
}

// --- A2b-5: the introspection WorkerEntrypoint's env slice -----------------------------------------
// mcp (A8) RPCs auth.introspect(token) over a service binding to validate an opaque provider token. The
// only binding the provider's unwrapToken touches is OAUTH_KV (the grant/token store on THIS Worker).
export interface IntrospectEnv {
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env).unwrapToken reads it. */
  OAUTH_KV: unknown;
}

/** Validate the env for the introspect entrypoint, fail-closed. */
export function readIntrospectEnv(env: Record<string, unknown>): IntrospectEnv {
  if (env.OAUTH_KV == null || typeof env.OAUTH_KV !== "object") {
    throw new Error("introspect env: missing OAUTH_KV binding");
  }
  return env as unknown as IntrospectEnv;
}

// --- A3d: the /authorize + /consent/decision env slice ---------------------------------------------
// The consent flow needs: the full Better Auth runtime to resolve the session (so it carries AuthEnv);
// CONSENT_TICKET_KEY (the 32-byte HMAC secret signing the stateless consent ticket); OAUTH_KV (getOAuthApi
// parseAuthRequest/lookupClient/completeAuthorization). HYPERDRIVE_TENANT (in AuthEnv) backs getConsentOrg.
export interface AuthorizeEnv extends AuthEnv {
  /** Base64 of a 32-byte HMAC key — signs/verifies the consent ticket (importConsentTicketKey). */
  CONSENT_TICKET_KEY: Secret;
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env) reads it per request. */
  OAUTH_KV: unknown;
}

/**
 * Validate + narrow the env for the consent endpoints, fail-closed (naming the missing key, never its
 * value): reuses readAuthEnv (the session runtime) then asserts the ticket key + OAUTH_KV.
 */
export function readAuthorizeEnv(env: Record<string, unknown>): AuthorizeEnv {
  readAuthEnv(env);
  if (!secretPresent(env.CONSENT_TICKET_KEY)) {
    throw new Error("authorize env: missing or empty required secret CONSENT_TICKET_KEY");
  }
  if (env.OAUTH_KV == null || typeof env.OAUTH_KV !== "object") {
    throw new Error("authorize env: missing OAUTH_KV binding");
  }
  return env as unknown as AuthorizeEnv;
}

/** Resolve every secret to a plain string (Better Auth + the hasher take strings). */
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

// URL/string constants live in ./urls (dependency-free) so client components can import them without
// pulling this module's server-only deps into the browser bundle. Re-exported for the runtime's imports.
export { APP_BASE_URL, MAGIC_LINK_FROM, PROD_AUTH_BASE_URL } from "./urls";
