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

/** Per-attempt timeout for the reveal RPC. Bounds the cold path (Hyperdrive connect + a KMS Decrypt,
 *  itself ~5s-bounded) so a hung reveal resolves the Suspense boundary to the hint instead of hanging. */
const REVEAL_TIMEOUT_MS = 6_000;

/** Injectable seam for tests (the default binds the live INGEST_URL_REVEALER service binding). */
export interface EndpointRevealDeps {
  readonly revealer: IngestUrlRevealerRpc | undefined;
  readonly apex: string;
  /** Per-attempt timeout (testability); defaults to {@link REVEAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Resolve `p`, or reject once `ms` elapses. The abandoned promise keeps running harmlessly (Worker). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reveal timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** One reveal attempt: the engine RPC (timeout-bounded) → `${apex}/<token>`, or null for a no-recoverable-copy
 *  / not-found result (NOT a throw, so it never triggers a retry). A transient fault throws (→ retry). */
async function revealOnce(
  revealer: IngestUrlRevealerRpc,
  apex: string,
  input: { orgId: string; endpointId: string },
  timeoutMs: number,
): Promise<string | null> {
  const rpc = revealer.revealIngestToken(input.orgId, input.endpointId);
  rpc.catch(() => {}); // if a timed-out attempt later rejects, don't surface it as an unhandled rejection
  const result = await withTimeout(rpc, timeoutMs);
  if (!result.found || result.token === null) return null;
  return `${apex}/${result.token}`;
}

/**
 * Reveal an endpoint's always-shown ingest URL for the dashboard. Returns the `${apex}/<token>` URL, or
 * `null` when there is no recoverable copy (the endpoint predates sealed storage → "rotate to reveal"), the
 * revealer binding isn't provisioned (dev/preview), or a transient reveal fault persists — the endpoint-detail
 * page shows the rotate-to-reveal hint rather than failing the whole view. `found:false` (a deleted endpoint
 * racing the metadata load) also degrades to null.
 *
 * RETRY-ONCE: the reveal's cold path (a cold Hyperdrive connection + a first-call KMS Decrypt) can throw a
 * transient "Network connection lost"-class fault or time out on the first call after an engine isolate spins
 * up. A single retry recovers it — the second attempt reuses the now-warm isolate (the DEK cache is warmed, so
 * no second KMS round-trip; the Hyperdrive connection is warmer), so the URL appears on the FIRST page load
 * instead of only after a manual reload. Only a second failure degrades to the hint.
 */
export async function revealEndpointIngestUrl(
  input: { orgId: string; endpointId: string },
  injected?: EndpointRevealDeps,
): Promise<string | null> {
  const revealer = injected?.revealer ?? getIngestUrlRevealer();
  if (!revealer) return null; // unprovisioned binding → degrade to "rotate to reveal", never crash
  const apex = injected?.apex ?? normalizeIngestApex(getIngestBaseUrl());
  const timeoutMs = injected?.timeoutMs ?? REVEAL_TIMEOUT_MS;
  try {
    return await revealOnce(revealer, apex, input, timeoutMs);
  } catch {
    // First attempt threw/timed out — retry ONCE against the now-warm isolate before degrading.
    try {
      return await revealOnce(revealer, apex, input, timeoutMs);
    } catch (err) {
      // Both attempts failed. Log the class only (never the token / String(err)) and degrade to the hint.
      console.warn(
        JSON.stringify({
          message: "endpoint.reveal_failed",
          error: err instanceof Error ? err.name : "unknown",
        }),
      );
      return null;
    }
  }
}
