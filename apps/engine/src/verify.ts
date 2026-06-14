// The real synchronous provider-signature verification step for the wbhk.my write path.
//
// Given the detected provider + the endpoint's sealed signing secrets (delivered on the principal),
// unseal the matching-provider secrets and run the frozen verify adapter over the EXACT captured raw
// bytes. Best-effort by contract: it returns a typed VerificationResult diagnostic and NEVER throws
// to block capture (capture is the floor — an unverifiable event is still stored, verified=false).
// The whole body is guarded so the no-throw contract is enforced HERE, not delegated to the caller.
//
// AAD: the unseal context's org/endpoint are the AUTHORITATIVE values handleIngest resolved from the
// token (not the per-secret cached context), and keyId is the secret's own row id. So a poisoned
// cached context (mismatched org/endpoint) can't unseal under a foreign binding — the GCM tag fails
// and that secret is skipped (never a false positive).

import { fromCachedSealedSecret } from "@webhook-co/db";
import { getAdapterForScheme, type SecretStore, type VerificationResult } from "@webhook-co/shared";

import { type VerificationOutcome, type VerifyIngestInput } from "./ingest";

const UNVERIFIED: VerificationOutcome = { verified: false, verification: null };

/** Optional structured-log sink for skipped-unseal observability (never receives plaintext). */
export type VerifyLog = (event: string, fields: Record<string, unknown>) => void;

/**
 * Build the verify dep over a SecretStore. `now` supplies the verification clock (the server receive
 * time) so each adapter's replay-window check is deterministic and testable. `log` (optional)
 * surfaces per-secret unseal failures so a systemic fault (wrong KEK redeployed, an AAD-binding
 * attack) is observable rather than silently producing verified=false.
 */
export function makeVerifyIngest(
  store: SecretStore,
  now: () => Date,
  log?: VerifyLog,
): (input: VerifyIngestInput) => Promise<VerificationOutcome> {
  return async function verify(input: VerifyIngestInput): Promise<VerificationOutcome> {
    try {
      // Unknown sender or no adapter for the scheme -> capture as unverified (no diagnostic). A
      // missing adapter must never block capture.
      if (input.provider === null) return UNVERIFIED;
      const adapter = getAdapterForScheme(input.provider);
      if (adapter === undefined) return UNVERIFIED;

      // Unseal the secrets registered for THIS provider, newest-first (the cached list is already
      // ordered). Provider match is case-insensitive + trimmed: the stored `provider` column is
      // free-form text, so a non-canonical casing ('Stripe') must not silently skip a valid secret.
      // A secret that fails to unseal (corrupt/rotated-away/poisoned context) is skipped, not fatal.
      const secrets: string[] = [];
      for (const cached of input.sealedSecrets) {
        if (cached.provider.trim().toLowerCase() !== input.provider) continue;
        try {
          const { sealed } = fromCachedSealedSecret(cached);
          const plaintext = await store.openString(sealed, {
            orgId: input.orgId,
            endpointId: input.endpointId,
            keyId: cached.id, // the secret's row id IS the seal keyId (addProviderSecret binds it)
          });
          secrets.push(plaintext);
        } catch (err) {
          // Skip this secret; never let one bad secret abort verification of the rest. Surface it so
          // a systemic unseal failure (vs a plain no-match) is observable. keyId is the non-secret id.
          log?.("verify.unseal_skipped", { keyId: cached.id, error: String(err) });
        }
      }

      const result: VerificationResult = await adapter.verify({
        rawBody: input.rawBody,
        headers: input.headers,
        secrets,
        now: now(),
      });
      return { verified: result.ok, verification: result };
    } catch (err) {
      // Self-enforce the no-throw contract: any unexpected failure (a future adapter that throws, a
      // bad now()) degrades to unverified rather than propagating into the capture path.
      log?.("verify.failed", { error: String(err) });
      return UNVERIFIED;
    }
  };
}
