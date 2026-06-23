import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { SessionExchangeBinding } from "./session-exchange";

/**
 * The app. Worker's runtime config + secrets. Secrets are Cloudflare Secrets Store bindings in prod
 * (read via `.get()`) and plain strings in dev/test; URLs default to the prod hosts. Read per-request
 * — `getCloudflareContext()` is only available inside a workerd request, so outside one (node/test/
 * `next dev` without bindings) we fall back to `process.env` + dev defaults. The session secret fails
 * **closed in production**: a missing binding throws rather than signing sessions with a dev default.
 */

const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
const DEV_AUTH_BASE_URL = "http://localhost:3001";
// Dev-only signing key — sessions minted with it are worthless in prod (which fails closed below).
const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-not-for-production-use";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The Worker env when inside a workerd request; `{}` otherwise (node/test/dev-without-bindings). */
function workerEnv(): Record<string, unknown> {
  try {
    return (getCloudflareContext().env ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a value that may be a Secrets Store binding (`.get()`) or a plain string. */
async function readSecret(value: unknown): Promise<string | null> {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value && typeof (value as { get?: unknown }).get === "function") {
    const resolved = await (value as { get: () => Promise<unknown> }).get();
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  }
  return null;
}

// Dev-only base64 secrets (32 bytes each) — usable only in dev/test against a local DB; prod fails closed.
const DEV_CREDENTIAL_PEPPER = btoa("dev-only-credential-pepper-32by!");
const DEV_AUDIT_CHAIN_KEY = btoa("dev-only-audit-chain-key-32bytes");

/**
 * Read a secret by binding name: the Secrets Store binding (prod, via `.get()`) or `process.env`
 * (dev/test), falling back to a fixed dev value outside production. **Production fails closed** — a
 * missing secret throws rather than using a dev default (the session signer / pepper / audit key must
 * be real in prod).
 */
async function readConfiguredSecret(name: string, devFallback: string): Promise<string> {
  const fromBinding = await readSecret((workerEnv() as Record<string, unknown>)[name]);
  const fromProcess = process.env[name];
  const secret = fromBinding ?? (fromProcess && fromProcess.length > 0 ? fromProcess : null);
  if (secret) return secret;
  if (isProduction()) {
    throw new Error(`${name} is not configured`);
  }
  return devFallback;
}

/** The HMAC secret that signs the app. session cookie. */
export function getSessionSecret(): Promise<string> {
  return readConfiguredSecret("SESSION_TOKEN_SECRET", DEV_SESSION_SECRET);
}

/** The base64 credential pepper (>=32 bytes) — keys the api-key HMAC; byte-identical across api/engine/mcp/web. */
export function getCredentialPepper(): Promise<string> {
  return readConfiguredSecret("CREDENTIAL_PEPPER", DEV_CREDENTIAL_PEPPER);
}

/** The base64 audit-chain HMAC key — signs the `key_minted` audit row (the same key every surface signs with). */
export function getAuditChainKey(): Promise<string> {
  return readConfiguredSecret("AUDIT_CHAIN_HMAC_KEY", DEV_AUDIT_CHAIN_KEY);
}

/**
 * The `AUTH_SESSION_EXCHANGE` Cloudflare service binding — auth.'s SessionExchange WorkerEntrypoint, reachable
 * as a direct RPC (no public HTTP hop). Bound only at deploy (the gen-wrangler-prod overlay); `undefined` in
 * dev/preview and before the binding is provisioned, so `exchangeTicket` transparently falls back to the
 * public `POST /session/exchange` fetch. Detected structurally (an object with an `exchange` method) so a
 * mis-shaped binding never masquerades as a working RPC.
 */
export function getSessionExchangeBinding(): SessionExchangeBinding | undefined {
  const binding = workerEnv().AUTH_SESSION_EXCHANGE;
  if (binding && typeof (binding as { exchange?: unknown }).exchange === "function") {
    return binding as SessionExchangeBinding;
  }
  return undefined;
}

/** The auth. origin to backchannel the A-SX `/session/exchange` against. */
export function getAuthBaseUrl(): string {
  const fromBinding = workerEnv().AUTH_BASE_URL;
  const url =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    (process.env.AUTH_BASE_URL && process.env.AUTH_BASE_URL.length > 0
      ? process.env.AUTH_BASE_URL
      : null);
  if (url) return url;
  return isProduction() ? PROD_AUTH_BASE_URL : DEV_AUTH_BASE_URL;
}
