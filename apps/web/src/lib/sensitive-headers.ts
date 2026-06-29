import "server-only";

import { LOGGABLE_HEADER_ALLOWLIST } from "@webhook-co/shared";

// Captured inbound headers are stored UNSCRUBBED. The dashboard inspector decides which header VALUES are
// safe to show inline vs. redacted-and-revealed-on-demand. The policy is FAIL-CLOSED: a header is shown
// inline only if it is on a known-safe allowlist; everything else is masked, so an unanticipated secret
// header (X-Access-Key, X-Encryption-Key, a new provider signature) can never leak its value into the
// client props by omission.
//
// The base list is the codebase's canonical log-boundary allowlist (@webhook-co/shared), shared so the
// security-critical "what's safe" decision can't drift. We EXTEND it with common, non-secret request
// headers (routing / client-identity) so the inspector isn't a wall of reveal buttons for benign headers —
// these are explicitly enumerated (never a pattern), so widening stays fail-closed.
const INSPECTOR_SAFE_EXTRA: ReadonlySet<string> = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "x-request-id",
  "x-correlation-id",
  "cf-ray",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-visitor",
  "accept-language",
  "accept-charset",
  "referer",
  "origin",
  "via",
  "forwarded",
]);

/** Whether a header's value must be redacted server-side (masked + revealed on demand). */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !LOGGABLE_HEADER_ALLOWLIST.has(lower) && !INSPECTOR_SAFE_EXTRA.has(lower);
}
