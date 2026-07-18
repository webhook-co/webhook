// The telemetry data-safety boundary (ADR-0125). Every attribute we put on a span, a structured log,
// or a metric passes an explicit ALLOWLIST here — anything not known-safe is dropped. This exists
// because a webhook ingest URL carries a live bearer token in its path, and any attribute recording a
// URL, header, or body would exfiltrate it. This boundary governs OUR spans/logs only; it cannot reach
// Cloudflare's managed root span (which is why native trace export is removed from token-bearing
// workers — see ADR-0124/0125), so it must be the sole path by which our code emits attributes.

import { LOGGABLE_HEADER_ALLOWLIST, redactSecret } from "./redaction";

/** Primitive attribute value — the only shapes an OTel attribute / AE blob may hold. */
export type SafeAttributeValue = string | number | boolean;

/**
 * Known credential shapes in this codebase — api keys (`whk_`), signing secrets (`whsec_`), bearer
 * tokens, Stripe keys (`sk_`/`pk_`), and JWTs. Matched at a boundary (start, `/`, or whitespace) so an
 * EMBEDDED credential (e.g. a full ingest URL `https://wbhk.my/whk_live_…` mistakenly set on a safe
 * key) is caught, while an innocuous substring (`task_force`) is not. A value matching one is redacted
 * even on an allowlisted key: the allowlist should already keep credentials off spans, so this is
 * defense in depth against a mistake, not the primary control.
 */
const SECRET_VALUE_SHAPE =
  /(^|[/\s])(whk_|whsec_|sk_[a-z]+_|pk_[a-z]+_|Bearer\s|eyJ[A-Za-z0-9_-]+\.)/;

/** True if a string value looks like a credential and must be masked before it can be emitted. */
function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE_SHAPE.test(value);
}

/** `http.request.header.<name>` / `http.response.header.<name>` → the lowercase header name, else null. */
function headerNameOf(key: string): string | null {
  const m = /^http\.(?:request|response)\.header\.(.+)$/.exec(key);
  return m === null ? null : m[1]!.toLowerCase();
}

/**
 * Attribute keys that are always safe to emit: enums, templated routes, booleans, small ints. NEVER
 * `url.path`/`url.full`/`url.query`/`http.url` (they carry the ingest token) — their absence from this
 * set is what drops them.
 */
const SPAN_SAFE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "http.request.method",
  "wbhk.outcome",
]);

/**
 * Opaque tenant/resource identifiers. Safe in IN-CF sinks (Analytics Engine blobs, Workers Logs,
 * Postgres) — they're the point of operational triage and stay within an existing Cloudflare
 * sub-processor. FORBIDDEN in EXPORTED spans, which go to a new off-platform (possibly cross-region)
 * backend: an `org_id` mapping to an identifiable EU customer is pseudonymous personal data (ADR-0125).
 * So they pass this boundary only when the caller opts in with `allowIdentifiers` (an in-CF sink).
 */
const SPAN_IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  "wbhk.org_id",
  "wbhk.endpoint_id",
  "wbhk.event_id",
  "wbhk.delivery_id",
  "wbhk.correlation_id",
]);

/** Options for {@link spanSafeAttributes}. */
export interface SpanSafeOptions {
  /** Permit opaque identifier keys. Set ONLY for in-CF sinks (AE / Workers Logs / Postgres), never
   *  for a span that is exported off-platform. Defaults to false — the export-safe posture. */
  readonly allowIdentifiers?: boolean;
}

/**
 * Project a candidate attribute map into a safe view: keep only allowlisted keys with primitive values;
 * drop everything else. Defaults to the export-safe posture (identifiers dropped).
 */
export function spanSafeAttributes(
  attrs: Readonly<Record<string, unknown>>,
  opts: SpanSafeOptions = {},
): Record<string, SafeAttributeValue> {
  const out: Record<string, SafeAttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const headerName = headerNameOf(key);
    const allowed =
      headerName !== null
        ? // Header attributes are an IN-CF concern: the loggable allowlist was built for in-CF logging
          // and contains per-event ids (webhook-id, x-github-delivery), so gate the whole header branch
          // behind allowIdentifiers — no request/response header reaches an EXPORTED span.
          opts.allowIdentifiers === true && LOGGABLE_HEADER_ALLOWLIST.has(headerName)
        : SPAN_SAFE_ATTRIBUTE_KEYS.has(key) ||
          (opts.allowIdentifiers === true && SPAN_IDENTIFIER_KEYS.has(key));
    if (!allowed) continue;
    if (typeof value === "string") {
      out[key] = looksLikeSecret(value) ? redactSecret(value) : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
