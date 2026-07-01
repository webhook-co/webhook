// The Tier-4 non-cryptographic authenticity providers (S2.2 A5), each a thin config over the shared
// `token-auth` factory. None signs the payload — a match surfaces as the weaker "authenticated" status
// (authenticity "token"/"basic"), not cryptographic "verified". See ./token-auth for the four sources.

import type { VerifyAdapter } from "../../adapter";
import { PROVIDER_TOLERANCE_SECONDS, type Provider } from "../config";
import { makeTokenAuthAdapter, type TokenAuthConfig } from "./token-auth";

const TOKEN_AUTH: ReadonlyArray<Omit<TokenAuthConfig, "toleranceSeconds">> = [
  // Single FIXED-header token (GitLab's "Secret token" in default mode — plain equality, not its opt-in HMAC).
  {
    slug: "gitlab",
    source: { kind: "header", name: "x-gitlab-token" },
    authenticity: "token",
    signatureHeader: "x-gitlab-token",
  },
  // A body JSON field carries the operator's subscription secret. Microsoft Graph batches per subscription,
  // so every element shares the clientState; we check the first (`value[0].clientState`) — an attacker can't
  // forge any element's value without the secret. (The one-time `?validationToken` echo is ingest-path.)
  {
    slug: "microsoft_graph",
    source: { kind: "jsonField", path: "value.0.clientState" },
    authenticity: "token",
    signatureHeader: "",
  },
  // HTTP Basic (`Authorization: Basic b64(user:pass)`); registered secret = the plain "user:pass".
  {
    slug: "chargebee",
    source: { kind: "basicAuth" },
    authenticity: "basic",
    signatureHeader: "authorization",
  },
  {
    slug: "postmark",
    source: { kind: "basicAuth" },
    authenticity: "basic",
    signatureHeader: "authorization",
  },
  {
    slug: "sparkpost",
    source: { kind: "basicAuth" },
    authenticity: "basic",
    signatureHeader: "authorization",
  },
  // Operator-CONFIGURED header NAME + value — no fixed header to detect, so the secret is JSON {header, token}.
  {
    slug: "okta",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  {
    slug: "bigcommerce",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  {
    slug: "datadog",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  {
    slug: "brevo",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  // S8 coverage — more Tier-4 non-crypto authenticity providers (doc-verified 2026-07-01).
  // Telegram sends the operator's `setWebhook` secret in a FIXED header.
  {
    slug: "telegram",
    source: { kind: "header", name: "x-telegram-bot-api-secret-token" },
    authenticity: "token",
    signatureHeader: "x-telegram-bot-api-secret-token",
  },
  // Mixpanel COHORT-SYNC webhooks offer optional HTTP Basic auth; registered secret = "user:pass".
  // (Scope: this is the cohort-sync product. Mixpanel's separate event-export/pipeline webhooks DO sign
  // with an `x-mixpanel-signature` HMAC-SHA1 — that's a different product; don't "upgrade" this row to it.)
  {
    slug: "mixpanel",
    source: { kind: "basicAuth" },
    authenticity: "basic",
    signatureHeader: "authorization",
  },
  // Operator-CONFIGURED header name + value (secret = JSON {header, token}). New Relic notification
  // destinations, Fillout's advanced custom-header, and Zapier's headers/basic-auth fields.
  // (Scope: Fillout's FORM-submission webhook is custom-header only. Its separate database/tables webhook
  // product signs with an `X-Webhook-Signature` HMAC-SHA256 — a different product; don't conflate them.)
  {
    slug: "new_relic",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  {
    slug: "fillout",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
  {
    slug: "zapier",
    source: { kind: "configuredHeader" },
    authenticity: "token",
    signatureHeader: "",
  },
];

export const TOKEN_AUTH_ADAPTERS: Partial<Record<Provider, VerifyAdapter>> = Object.fromEntries(
  TOKEN_AUTH.map((config) => [
    config.slug,
    makeTokenAuthAdapter({ ...config, toleranceSeconds: PROVIDER_TOLERANCE_SECONDS[config.slug] }),
  ]),
) as Partial<Record<Provider, VerifyAdapter>>;

/**
 * The providers whose registered secret is an operator-configured `{ header, token }` JSON (Okta,
 * BigCommerce, Datadog, Brevo). Derived from the same config list so it can never drift. The contract
 * validates these secrets with `isUsableConfiguredHeaderSecret` at registration.
 */
export const CONFIGURED_HEADER_PROVIDERS: ReadonlySet<Provider> = new Set(
  TOKEN_AUTH.filter((c) => c.source.kind === "configuredHeader").map((c) => c.slug),
);
