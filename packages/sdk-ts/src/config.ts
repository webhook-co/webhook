// Client configuration resolution. The base URL is the destination for the bearer credential, so it MUST
// be https — plaintext http is rejected except for loopback (local dev / self-host on the same machine)
// — otherwise a misconfiguration could downgrade the key to plaintext or redirect it to a hostile host.
// The URL must be a clean origin+path (no query/fragment); the normalised form is returned.

import { WebhookConfigError } from "./errors.js";

/** The canonical hosted API (mirrors the OpenAPI `servers` entry). */
export const DEFAULT_BASE_URL = "https://api.webhook.co";

/** Hosts where plaintext http:// is acceptable (loopback only). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate + normalise a base URL (defaulting to the hosted API). https-only except loopback http; no
 * query/fragment; a trailing slash is stripped so `${base}/v1/…` concatenation is always well-formed.
 */
export function resolveBaseUrl(raw: string | undefined): string {
  const value = raw ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookConfigError(`invalid base URL: ${value}`);
  }
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttpOk) {
    throw new WebhookConfigError(`base URL must be https (got ${url.protocol}//): ${value}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new WebhookConfigError(`base URL must not carry a query or fragment: ${value}`);
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}
