import { z } from "zod";

// The webhook signature schemes we recognize. Standard Webhooks is the contract
// (ADR-0008); the provider schemes cover the inbound verification wedge (§0.5).
// `unknown` is a captured-but-unverifiable sender (capture never blocks
// on a missing adapter — full-fidelity capture is the floor, §0.5).
export const WEBHOOK_SCHEMES = [
  "standard_webhooks",
  "stripe",
  "github",
  "shopify",
  "slack",
  "unknown",
] as const;

export const WebhookSchemeSchema = z.enum(WEBHOOK_SCHEMES);
export type WebhookScheme = z.infer<typeof WebhookSchemeSchema>;

/**
 * Per-scheme timestamp-skew tolerance, in seconds, frozen here so every surface and
 * the inbound verifier share one replay window (§0.5). Schemes without a signed
 * timestamp (GitHub, Shopify) keep a value for interface uniformity; their adapters
 * ignore it. 300s (5 min) matches Slack's and Stripe's documented defaults.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS: Readonly<Record<WebhookScheme, number>> = {
  standard_webhooks: 300,
  stripe: 300,
  github: 300,
  shopify: 300,
  slack: 300,
  unknown: 300,
};
