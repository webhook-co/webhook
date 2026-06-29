// The real synchronous provider-signature verification step for the wbhk.my write path.
//
// Selection is driven by what the operator REGISTERED on the endpoint (the providers of its sealed
// signing secrets), NOT by header detection. This is what lets providers that collide on a signature
// header — e.g. GitHub and Meta both send `x-hub-signature-256`, Bitbucket/Jira/Intercom all send
// `x-hub-signature` — each be verifiable: header sniffing can only pick one, but the endpoint's
// registered secret says which adapter to actually run. For each distinct registered provider we
// unseal its secrets and run its adapter over the EXACT captured raw bytes; the first that verifies
// wins (and names the event's provider). The header-detected provider is only a try-first ordering
// hint for the common single-provider endpoint.
//
// Best-effort by contract: returns a typed VerificationResult diagnostic and NEVER throws to block
// capture (capture is the floor — an unverifiable event is still stored, verified=false). The whole
// body is guarded so the no-throw contract is enforced HERE, not delegated to the caller.
//
// AAD: the unseal context's org/endpoint are the AUTHORITATIVE values handleIngest resolved from the
// token (not the per-secret cached context), and keyId is the secret's own row id. So a poisoned
// cached context (mismatched org/endpoint) can't unseal under a foreign binding — the GCM tag fails
// and that secret is skipped (never a false positive).

import { type CachedSealedSecret, fromCachedSealedSecret } from "@webhook-co/db";
import {
  getAdapterForScheme,
  PROVIDERS,
  type Provider,
  type SecretStore,
  type VerificationResult,
} from "@webhook-co/shared";

import { type VerificationOutcome, type VerifyIngestInput } from "./ingest";

const UNVERIFIED: VerificationOutcome = { verified: false, verification: null };

/** Optional structured-log sink for skipped-unseal observability (never receives plaintext). */
export type VerifyLog = (event: string, fields: Record<string, unknown>) => void;

/** Canonicalize the free-text `provider` column to a known Provider, or null if unrecognized. */
function canonicalProvider(raw: string): Provider | null {
  const canon = raw.trim().toLowerCase();
  return (PROVIDERS as readonly string[]).includes(canon) ? (canon as Provider) : null;
}

/**
 * The distinct providers registered on this endpoint, in the order to try them: the header-detected
 * `hint` first (if it's actually registered — a fast path for the common single-provider endpoint),
 * then the rest. A registered provider whose value isn't a recognized Provider is dropped.
 */
function registeredProviders(
  sealedSecrets: readonly CachedSealedSecret[],
  hint: Provider | null,
): Provider[] {
  const registered = new Set<Provider>();
  for (const cached of sealedSecrets) {
    const provider = canonicalProvider(cached.provider);
    if (provider !== null) registered.add(provider);
  }
  const order: Provider[] = [];
  if (hint !== null && registered.has(hint)) order.push(hint);
  for (const provider of registered) {
    if (!order.includes(provider)) order.push(provider);
  }
  return order;
}

/** Is a provider's signature header present on the request? (`name` is already lowercase.) */
function hasHeader(headers: ReadonlyArray<readonly [string, string]>, name: string): boolean {
  for (const [key] of headers) if (key.toLowerCase() === name) return true;
  return false;
}

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
  /** Unseal the registered secrets for one provider, newest-first; skip+log any that fail to unseal. */
  async function unsealFor(input: VerifyIngestInput, provider: Provider): Promise<string[]> {
    const secrets: string[] = [];
    for (const cached of input.sealedSecrets) {
      if (canonicalProvider(cached.provider) !== provider) continue;
      try {
        const { sealed } = fromCachedSealedSecret(cached);
        const plaintext = await store.openString(sealed, {
          orgId: input.orgId,
          endpointId: input.endpointId,
          keyId: cached.id, // the secret's row id IS the seal keyId (addProviderSecret binds it)
        });
        secrets.push(plaintext);
      } catch (err) {
        // Skip this secret; never let one bad secret abort verification of the rest. Surface it so a
        // systemic unseal failure (vs a plain no-match) is observable. keyId is the non-secret id.
        log?.("verify.unseal_skipped", { keyId: cached.id, error: String(err) });
      }
    }
    return secrets;
  }

  return async function verify(input: VerifyIngestInput): Promise<VerificationOutcome> {
    try {
      // Drive selection from the endpoint's registered providers (not header detection). No registered
      // secret -> nothing to verify against -> unverified (no diagnostic); capture still proceeds.
      const providers = registeredProviders(input.sealedSecrets, input.provider);
      if (providers.length === 0) return UNVERIFIED;

      const at = now(); // one consistent verification clock for every adapter tried
      let best: VerificationResult | null = null;
      for (const provider of providers) {
        const adapter = getAdapterForScheme(provider);
        if (adapter === undefined) continue; // a registered provider with no adapter -> skip
        // Skip a provider whose signature header isn't even present: don't pay a KMS DEK-unwrap +
        // GCM open (on the durable-before-ACK path) to unseal secrets for a request it can't apply
        // to, and keep `verification: null` for a non-matching capture instead of a noisy
        // MISSING_HEADER. (So every adapter we run HAS its header — it never returns MISSING_HEADER
        // — and keeping the first failure yields the hint-first-ordered diagnostic.)
        if (!hasHeader(input.headers, adapter.signatureHeader)) continue;
        const secrets = await unsealFor(input, provider);
        const result = await adapter.verify({
          rawBody: input.rawBody,
          headers: input.headers,
          secrets,
          now: at,
        });
        if (result.ok) return { verified: true, verification: result, provider };
        best ??= result;
      }
      return { verified: false, verification: best };
    } catch (err) {
      // Self-enforce the no-throw contract: any unexpected failure (a future adapter that throws, a
      // bad now()) degrades to unverified rather than propagating into the capture path.
      log?.("verify.failed", { error: String(err) });
      return UNVERIFIED;
    }
  };
}
