// Adapter registry + header-based scheme detection. Almost every adapter is produced from its config
// (./config) by `makeHmacAdapter`, so the REGISTRY is DERIVED from PROVIDER_CONFIGS — a new provider is
// one config row. The few schemes whose verification can't be a single HMAC config (./bespoke — e.g.
// Twilio's runtime-branching form/JSON modes) ship a hand-written adapter that the registry prefers over
// the config-derived one. `unknown` has no adapter (capture never blocks on a missing adapter).
// Detection is by the presence of a scheme's signature header.

import type { VerifyAdapter } from "../adapter";
import type { WebhookScheme } from "../scheme";
import { BESPOKE_ADAPTERS } from "./bespoke";
import { PROVIDER_CONFIGS, PROVIDERS } from "./config";
import { makeHmacAdapter } from "./factory";

/** Every scheme that has an adapter (i.e. all of WEBHOOK_SCHEMES except `unknown`). */
export type AdapterScheme = Exclude<WebhookScheme, "unknown">;

const REGISTRY: Readonly<Record<AdapterScheme, VerifyAdapter>> = Object.fromEntries(
  PROVIDERS.map((slug) => [
    slug,
    BESPOKE_ADAPTERS[slug] ?? makeHmacAdapter(PROVIDER_CONFIGS[slug]),
  ]),
) as Record<AdapterScheme, VerifyAdapter>;

/** The schemes for which an adapter exists, in detection-precedence order (= PROVIDERS). */
export const ADAPTER_SCHEMES: readonly AdapterScheme[] = PROVIDERS;

/** Resolve the adapter for a scheme. `unknown` (or any non-adapter scheme) → undefined. */
export function getAdapterForScheme(scheme: WebhookScheme): VerifyAdapter | undefined {
  return scheme === "unknown" ? undefined : REGISTRY[scheme];
}

/**
 * Detect the scheme from the request's signature headers. Returns the first scheme
 * (in ADAPTER_SCHEMES order) whose signature header is present, else `unknown`.
 * Detection is identity-only; it does NOT validate the signature.
 */
export function detectScheme(headers: ReadonlyArray<readonly [string, string]>): WebhookScheme {
  const present = new Set<string>();
  for (const [k] of headers) present.add(k.toLowerCase());
  for (const scheme of ADAPTER_SCHEMES) {
    if (present.has(REGISTRY[scheme].signatureHeader)) return scheme;
  }
  return "unknown";
}
