import "server-only";

import type { IngestUrlRevealerRpc } from "@webhook-co/shared";

import { normalizeIngestApex } from "./endpoint-mutations";
import { auditIngestUrlDisclosureOnce } from "@webhook-co/db/ingest-url-reveal";
import { userActor } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { getTenantDb } from "./db";
import { getAuditChainKey, getIngestBaseUrl, getIngestUrlRevealer } from "./env";

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

/** Per-attempt timeout for the reveal RPC — bounds a HUNG cold call (Hyperdrive connect + a KMS Decrypt) so
 *  the Suspense boundary resolves to a hint instead of hanging. A timeout is NOT retried (see below). */
const REVEAL_TIMEOUT_MS = 5_000;

/**
 * The reveal outcome. The two non-URL states are deliberately DISTINCT so the UI never advises a destructive
 * action for a merely-slow reveal:
 *  - `no-copy`     — the endpoint has no recoverable token (it predates sealed storage). Rotating IS the fix.
 *  - `unavailable` — a TRANSIENT failure (a cold-path fault after the retry, a timeout, or an unprovisioned
 *                    binding in dev/preview). The token still exists; the user should refresh, NOT rotate.
 */
export type IngestUrlRevealResult =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "no-copy" }
  | { readonly kind: "unavailable" };

/** Injectable seam for tests (the default binds the live INGEST_URL_REVEALER service binding). */
export interface EndpointRevealDeps {
  readonly revealer: IngestUrlRevealerRpc | undefined;
  readonly apex: string;
  /** Per-attempt timeout (testability); defaults to {@link REVEAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** A timed-out attempt — distinct from a real RPC throw so the caller can choose NOT to retry a hang. */
class RevealTimeout extends Error {}

/** Resolve `p`, or reject with a {@link RevealTimeout} once `ms` elapses. The abandoned promise keeps
 *  running harmlessly (its rejection is muted by the caller) — a Worker discards it when the request ends. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RevealTimeout("reveal timed out")), ms);
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

/** Log a reveal fault (class ONLY — never the token / err.message / String(err)). */
function logRevealFault(message: string, err: unknown): void {
  console.warn(JSON.stringify({ message, error: err instanceof Error ? err.name : "unknown" }));
}

/** One reveal attempt: the engine RPC (timeout-bounded) → the URL, or `no-copy` for a token-less result
 *  (NOT a throw, so it never triggers a retry). A transient fault / timeout throws (handled by the caller). */
async function revealOnce(
  revealer: IngestUrlRevealerRpc,
  apex: string,
  input: { orgId: string; endpointId: string },
  timeoutMs: number,
): Promise<IngestUrlRevealResult> {
  const rpc = revealer.revealIngestToken(input.orgId, input.endpointId);
  rpc.catch(() => {}); // a timed-out attempt that later rejects must not surface as an unhandled rejection
  const result = await withTimeout(rpc, timeoutMs);
  if (!result.found || result.token === null) return { kind: "no-copy" };
  return { kind: "url", url: `${apex}/${result.token}` };
}

/**
 * Reveal an endpoint's always-shown ingest URL for the dashboard. NEVER throws — the reveal is fail-soft by
 * contract (it renders inside a <Suspense> with no error boundary, so a throw would blank the whole endpoint
 * page). Any fault degrades to `unavailable` (or `no-copy` for a genuinely token-less endpoint).
 *
 * RETRY-ONCE: the cold path (a cold Hyperdrive connection + a first-call KMS Decrypt) can throw a transient
 * "Network connection lost"-class fault on the first call after an engine isolate spins up. A single retry
 * recovers it — the second attempt reuses the now-warm isolate (the DEK cache is warmed, so no second KMS
 * round-trip; the connection is warmer) — so the URL appears on the FIRST page load instead of only after a
 * manual reload. A TIMEOUT is NOT retried: a hung attempt suggests sustained slowness where a retry would
 * only double engine/KMS load (and leave two RPCs in flight), so it degrades to `unavailable` immediately.
 */
export async function revealEndpointIngestUrl(
  input: { orgId: string; endpointId: string },
  injected?: EndpointRevealDeps,
): Promise<IngestUrlRevealResult> {
  try {
    const revealer = injected?.revealer ?? getIngestUrlRevealer();
    if (!revealer) return { kind: "unavailable" }; // unprovisioned (dev/preview) — token exists, don't rotate
    const apex = injected?.apex ?? normalizeIngestApex(getIngestBaseUrl());
    const timeoutMs = injected?.timeoutMs ?? REVEAL_TIMEOUT_MS;
    try {
      return await revealOnce(revealer, apex, input, timeoutMs);
    } catch (first) {
      logRevealFault("endpoint.reveal_retry", first); // observability: first-attempt fault (recoverable)
      if (first instanceof RevealTimeout) return { kind: "unavailable" }; // don't retry a hang
      try {
        return await revealOnce(revealer, apex, input, timeoutMs);
      } catch (second) {
        logRevealFault("endpoint.reveal_failed", second);
        return { kind: "unavailable" };
      }
    }
  } catch (fatal) {
    // Belt-and-suspenders: anything unexpected (e.g. a misconfigured INGEST_BASE_URL throwing in
    // normalizeIngestApex, or a binding-lookup fault) must NEVER crash the endpoint page. Degrade to the hint.
    logRevealFault("endpoint.reveal_failed", fatal);
    return { kind: "unavailable" };
  }
}

/**
 * Record the DASHBOARD ingest-URL disclosure to the tamper-evident audit chain — best-effort, deduped to the
 * FIRST view per (actor, endpoint) (S.9). Call ONLY after `revealEndpointIngestUrl` returned a real URL.
 *
 * FAIL-SOFT by contract, like the reveal itself: it runs inside the same <Suspense> with no error boundary,
 * so it must NEVER throw (a throw would blank the endpoint page) and must never block showing the URL — the
 * audit is a side effect of the disclosure, not a gate on it. Any fault degrades to a logged no-op; the URL
 * is already rendered regardless.
 *
 * Kept SEPARATE from `revealEndpointIngestUrl` (which deliberately holds no DB pool): the reveal is the
 * engine unseal, this is the control-plane audit. The dashboard has a real `session.userId`, so the row is
 * attributed to the human (`user:<id>`) — better attribution than the api path's null-actor bearer.
 */
export async function recordIngestUrlDisclosure(input: {
  orgId: string;
  userId: string;
  endpointId: string;
}): Promise<void> {
  try {
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    const app = await getTenantDb();
    try {
      await auditIngestUrlDisclosureOnce(
        app,
        auditKey,
        input.orgId,
        userActor(input.userId),
        input.endpointId,
      );
    } finally {
      await app.end({ timeout: 5 }).catch(() => {});
    }
  } catch (err) {
    // Never blank the page over an audit hiccup. Log so a persistently-failing disclosure audit is visible.
    logRevealFault("endpoint.disclosure_audit_failed", err);
  }
}
