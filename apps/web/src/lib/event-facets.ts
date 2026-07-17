import type { DedupStrategy, HttpMethod } from "@webhook-co/shared";

// Client-safe copies of the events filter-facet vocabularies, kept LOCAL (like verification-state.ts's
// VERIFICATION_STATES) so this client-bundled module doesn't pull the whole `@webhook-co/shared` barrel into
// the browser — and, more sharply, so it can't hit the Turbopack `export *` resolve-to-undefined trap. A
// drift test (event-facets.test.ts) asserts each matches the shared source, so the copy can't rot.

/** The seven standard HTTP verbs offered as the method facet (mirrors shared HTTP_METHODS). */
export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** The five dedup strategies offered as the dedup-strategy facet (mirrors shared DEDUP_STRATEGIES). */
export const DEDUP_STRATEGIES: readonly DedupStrategy[] = [
  "sw_webhook_id",
  "provider_event_id",
  "content_hash",
  "fields",
  "unique",
];

/** Human labels for the dedup-strategy slugs — the facet must never show a raw slug. */
export const DEDUP_STRATEGY_LABELS: Record<DedupStrategy, string> = {
  sw_webhook_id: "Webhook ID",
  provider_event_id: "Provider event ID",
  content_hash: "Content hash",
  fields: "Configured fields",
  unique: "Unique (no dedup)",
};
