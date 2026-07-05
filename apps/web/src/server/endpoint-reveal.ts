import "server-only";

import type { IngestUrlRevealerRpc } from "@webhook-co/shared";

import { normalizeIngestApex } from "./endpoint-mutations";
import { getIngestBaseUrl, getIngestUrlRevealer } from "./env";

// The dashboard's always-shown ingest URL (S8-remainder Slice 2b / decision-0018 / ADR-0101). The
// endpoint-detail page displays the wbhk.my/<token> URL PERSISTENTLY, as part of the endpoint's own config
// shown to a logged-in org member — the same posture as its id/name (which any member sees, and any member
// can already rotate to mint a fresh URL). So the dashboard reveal is a CONFIG READ, not a programmatic
// credential fetch: it is NOT audited per page-view and NOT rate-limited (that would pollute the
// tamper-evident control-plane audit chain with routine reads and could block an owner from viewing their
// own endpoint). The DELIBERATE, non-interactive reveal — the scripted exfil vector — is the api/cli/mcp
// `endpoints.revealIngestUrl` capability, which audits every disclosure + rate-limits.
//
// The UNSEAL stays engine-only + identifier-only: web passes (orgId, endpointId) to the engine's
// IngestUrlRevealer, which reads the sealed blob itself under the org's RLS and returns the plaintext token
// — web never holds the KEK or supplies a blob. So this seam needs no tenant DB pool of its own.

/** Injectable seam for tests (the default binds the live INGEST_URL_REVEALER service binding). */
export interface EndpointRevealDeps {
  readonly revealer: IngestUrlRevealerRpc | undefined;
  readonly apex: string;
}

/**
 * Reveal an endpoint's always-shown ingest URL for the dashboard. Returns the `${apex}/<token>` URL, or
 * `null` when there is no recoverable copy (the endpoint predates sealed storage → "rotate to reveal"), the
 * revealer binding isn't provisioned (dev/preview), or a transient reveal fault occurs — the endpoint-detail
 * page shows the rotate-to-reveal hint rather than failing the whole view. `found:false` (a deleted endpoint
 * racing the metadata load) also degrades to null.
 */
export async function revealEndpointIngestUrl(
  input: { orgId: string; endpointId: string },
  injected?: EndpointRevealDeps,
): Promise<string | null> {
  const revealer = injected?.revealer ?? getIngestUrlRevealer();
  if (!revealer) return null; // unprovisioned binding → degrade to "rotate to reveal", never crash
  try {
    const apex = injected?.apex ?? normalizeIngestApex(getIngestBaseUrl());
    const result = await revealer.revealIngestToken(input.orgId, input.endpointId);
    if (!result.found || result.token === null) return null;
    return `${apex}/${result.token}`;
  } catch (err) {
    // A transient unseal/KMS fault must not blank the endpoint page. Log the class only (never the token /
    // String(err)) and degrade — the URL falls back to the rotate-to-reveal hint.
    console.warn(
      JSON.stringify({
        message: "endpoint.reveal_failed",
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
    return null;
  }
}
