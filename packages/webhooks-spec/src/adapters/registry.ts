// Adapter registry + header-based scheme detection. One adapter per scheme (excluding
// `unknown`, which is a captured-but-unverifiable sender — capture never blocks on a
// missing adapter). Detection is by the presence of a scheme's signature header.

import type { VerifyAdapter } from "../adapter";
import type { WebhookScheme } from "../scheme";
import { PROVIDERS } from "./config";
import { githubAdapter } from "./github";
import { shopifyAdapter } from "./shopify";
import { slackAdapter } from "./slack";
import { standardWebhooksAdapter } from "./standard-webhooks";
import { stripeAdapter } from "./stripe";

/** Every scheme that has an adapter (i.e. all of WEBHOOK_SCHEMES except `unknown`). */
export type AdapterScheme = Exclude<WebhookScheme, "unknown">;

const REGISTRY: Readonly<Record<AdapterScheme, VerifyAdapter>> = {
  stripe: stripeAdapter,
  github: githubAdapter,
  shopify: shopifyAdapter,
  slack: slackAdapter,
  standard_webhooks: standardWebhooksAdapter,
};

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
