import { z } from "zod";

import { PROVIDER_TOLERANCE_SECONDS, PROVIDERS } from "./adapters/config";

// The webhook signature schemes we recognize = the provider vocabulary (PROVIDERS — the single
// source of truth in ./adapters/config) plus `unknown`, a captured-but-unverifiable sender
// (capture never blocks on a missing adapter — full-fidelity capture is the floor). Deriving
// from PROVIDERS means a new provider is one config row, not an edit here.
export const WEBHOOK_SCHEMES = [...PROVIDERS, "unknown"] as const;

export const WebhookSchemeSchema = z.enum(WEBHOOK_SCHEMES);
export type WebhookScheme = z.infer<typeof WebhookSchemeSchema>;

/**
 * Per-scheme timestamp-skew tolerance, in seconds, so every surface and the inbound verifier
 * share one replay window. Derived from each provider's configured tolerance
 * (PROVIDER_TOLERANCE_SECONDS) with `unknown` folded in. Schemes without a signed timestamp
 * (GitHub, Shopify) carry a value for interface uniformity; their adapters ignore it.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS: Readonly<Record<WebhookScheme, number>> = {
  ...PROVIDER_TOLERANCE_SECONDS,
  unknown: 300,
};
