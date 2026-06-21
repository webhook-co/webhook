import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

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

/**
 * The HMAC secret that signs the app. session cookie. Prod reads the Secrets Store binding and throws
 * if it's absent (never sign with a default); dev/test fall back to a fixed dev secret.
 */
export async function getSessionSecret(): Promise<string> {
  const fromBinding = await readSecret(workerEnv().SESSION_TOKEN_SECRET);
  const fromProcess = process.env.SESSION_TOKEN_SECRET;
  const secret = fromBinding ?? (fromProcess && fromProcess.length > 0 ? fromProcess : null);
  if (secret) return secret;
  if (isProduction()) {
    throw new Error("SESSION_TOKEN_SECRET is not configured");
  }
  return DEV_SESSION_SECRET;
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
