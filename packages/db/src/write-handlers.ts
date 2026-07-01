// The shared capability WRITE handlers — the mutation counterpart to createReadHandlers. Bound
// identically by apps/api (HTTP) and apps/mcp (MCP tools) via buildCapabilityHandlers, which merges the
// read + write maps into ONE capability-handler map both surfaces dispatch by name — so the surfaces
// can't drift and the write logic is tested once (the db pool). Each handler enforces the capability's
// scope FIRST, validates input against the contract Zod schema, runs the mutation under RLS, and returns
// the contract-shaped output. Every failure is a typed CapabilityFault the surface maps to its transport.
//
// SECURITY NOTE: on MCP there is NO edge scope gate (the api edge runs authorizeBearer before
// dispatch; mcp does not), so the in-handler ensureScope below is the SOLE authorization gate on that
// surface. It MUST run before any mint/insert — hence it is the first statement in every handler.

import {
  CapabilityFault,
  endpointsAddProviderSecret,
  endpointsCreate,
  endpointsDelete,
  endpointsListProviderSecrets,
  endpointsRevokeProviderSecret,
  endpointsRotate,
} from "@webhook-co/contract";
import {
  serializeBraintreePublicKey,
  serializeVerifyTokenSecret,
  type SecretSealer,
} from "@webhook-co/shared";

import type { Sql } from "./client";
import type { CredentialHasher } from "./credential";
import {
  createEndpointWithAudit,
  DEFAULT_MAX_ENDPOINTS_PER_ORG,
  deleteEndpointWithAudit,
  getEndpointIngestTokenHash,
  rotateEndpointWithAudit,
} from "./endpoints";
import {
  addProviderSecret,
  listEndpointProviderSecrets,
  revokeProviderSecret,
} from "./provider-secrets";
import {
  createReadHandlers,
  ensureScope,
  type CapabilityHandlers,
  type ReadHandlerDeps,
} from "./read-handlers";

// DEFAULT_MAX_ENDPOINTS_PER_ORG now lives in ./endpoints (the single source of truth, so the DB-direct
// dashboard imports the same value, not a copy); createWriteHandlers applies it when deps.maxEndpoints is
// omitted, and the barrel still re-exports it via `export * from "./endpoints"`.

export interface WriteHandlerDeps {
  /** webhook_app over the cache-disabled tenant binding — tenant writes run here. */
  readonly tenant: Sql;
  /** The credential hasher (CREDENTIAL_PEPPER) used to mint + hash the ingest token. */
  readonly hasher: CredentialHasher;
  /** Audit-chain HMAC key (AUDIT_CHAIN_HMAC_KEY) — signs the wha1/audit_log control-plane row. */
  readonly auditKey: CryptoKey;
  /** Ingest apex the returned ingestUrl is built from (e.g. https://wbhk.my). Validated per-call. */
  readonly ingestBaseUrl: string;
  /** Per-org endpoint soft cap; defaults to DEFAULT_MAX_ENDPOINTS_PER_ORG. */
  readonly maxEndpoints?: number;
  /**
   * Seals a provider signing secret on endpoints.addProviderSecret. In prod this is the engine's
   * ProviderSecretSealer reached over a service binding (api/mcp never hold the KEK — B0/D1); in tests
   * a local SecretStore. Write-only seam (`sealString`); required by addProviderSecret only.
   */
  readonly secretSealer?: SecretSealer;
  /**
   * Evict an ingest-token hash from the KV ingest cache (ADR-0076) — required by endpoints.delete +
   * endpoints.rotate to stop/redirect ingest on the wbhk.my hot path. Build it with makeIngestHashEvictor
   * over the engine's KV_CONFIG namespace (bound into api + mcp). Best-effort by construction (the
   * mutation is durable + self-healing without it); the read-only surfaces don't supply it.
   */
  readonly invalidateIngestHash?: (keyHash: Buffer) => Promise<void>;
}

/**
 * Validate + normalize the configured ingest apex, fail-closed, to its bare origin (scheme + host, no
 * trailing slash, no path/query/fragment). A missing / non-http(s) / path-bearing value would mint a
 * broken, UNRECOVERABLE one-time URL (`undefined/<token>` or `host/x?q=/<token>`), so this throws rather
 * than ever returning one. It lives in this shared seam (not per-surface) so api + mcp fail closed
 * identically, and it is invoked lazily inside the create handler — BEFORE the mint, and never on the
 * read path — so a misconfigured create-only var can neither commit an orphan endpoint nor break reads.
 * The throw is a plain Error (a server wiring fault → 500 on api / a generic tool error on mcp), not a
 * client-facing CapabilityFault.
 */
export function normalizeIngestApex(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("INGEST_BASE_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("INGEST_BASE_URL must be an absolute http(s) URL");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new Error("INGEST_BASE_URL must have no path, query, or fragment");
  }
  return url.origin; // scheme://host[:port], no trailing slash
}

export function createWriteHandlers(deps: WriteHandlerDeps): CapabilityHandlers {
  const maxEndpoints = deps.maxEndpoints ?? DEFAULT_MAX_ENDPOINTS_PER_ORG;
  const handlers: CapabilityHandlers = new Map();

  handlers.set(endpointsCreate.name, async (ctx, input) => {
    ensureScope(ctx, endpointsCreate); // FIRST — sole authz gate on mcp; no mint/write before this
    const parsed = endpointsCreate.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    // Validate the apex BEFORE minting: a misconfig must fail closed WITHOUT committing an orphan
    // endpoint whose one-time URL would then be unrecoverable.
    const apex = normalizeIngestApex(deps.ingestBaseUrl);
    const created = await createEndpointWithAudit(
      deps.tenant,
      { orgId: ctx.orgId, name: parsed.data.name, actor: ctx.userId ?? null, maxEndpoints },
      deps.hasher,
      deps.auditKey,
    );
    // The ingestUrl EMBEDS the plaintext token — the one-time reveal. Never log it; return it once.
    return {
      id: created.id,
      orgId: created.orgId,
      name: created.name,
      paused: created.paused,
      createdAt: created.createdAt,
      ingestUrl: `${apex}/${created.plaintext}`,
    };
  });

  // endpoints.delete + endpoints.rotate both need the KV ingest-cache evictor (ADR-0076). It's optional
  // on WriteHandlerDeps (read-only surfaces don't supply it), so resolve it once and fail LOUD (a plain
  // Error -> 500 / generic tool error, never a client CapabilityFault) if a write surface forgot to wire
  // it — a missing evictor would silently leave ingest live after a delete/rotate.
  function requireEvictor(): (keyHash: Buffer) => Promise<void> {
    if (deps.invalidateIngestHash === undefined) {
      throw new Error("write handlers: invalidateIngestHash dep is required for delete/rotate");
    }
    return deps.invalidateIngestHash;
  }

  function requireSealer(): SecretSealer {
    if (deps.secretSealer === undefined) {
      throw new Error(
        "write handlers: secretSealer dep is required for endpoints.addProviderSecret",
      );
    }
    return deps.secretSealer;
  }

  handlers.set(endpointsDelete.name, async (ctx, input) => {
    ensureScope(ctx, endpointsDelete); // FIRST — sole authz gate on mcp
    const parsed = endpointsDelete.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const evict = requireEvictor();
    const deleted = await deleteEndpointWithAudit(
      deps.tenant,
      { orgId: ctx.orgId, endpointId: parsed.data.endpointId, actor: ctx.userId ?? null },
      deps.auditKey,
    );
    // Evict so the deleted endpoint's token stops resolving NOW (the cold-lookup deleted_at filter is
    // the durable stop + the TTL self-heal; this makes it immediate). Best-effort — never fails the call.
    await evict(deleted.tokenHash);
    return { id: deleted.id, deletedAt: deleted.deletedAt };
  });

  handlers.set(endpointsRotate.name, async (ctx, input) => {
    ensureScope(ctx, endpointsRotate); // FIRST — sole authz gate on mcp
    const parsed = endpointsRotate.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const apex = normalizeIngestApex(deps.ingestBaseUrl); // validate BEFORE minting (mirrors create)
    const evict = requireEvictor();
    const rotated = await rotateEndpointWithAudit(
      deps.tenant,
      { orgId: ctx.orgId, endpointId: parsed.data.endpointId, actor: ctx.userId ?? null },
      deps.hasher,
      deps.auditKey,
    );
    // HARD cutover: evict the OLD token so the old URL stops resolving immediately. Best-effort —
    // never fails the call (a thrown eviction would lose the one-time reveal of the NEW url below).
    await evict(rotated.oldTokenHash);
    // The ingestUrl EMBEDS the freshly-minted plaintext token — the one-time reveal. Return it once.
    return {
      id: rotated.id,
      orgId: rotated.orgId,
      name: rotated.name,
      paused: rotated.paused,
      createdAt: rotated.createdAt,
      ingestUrl: `${apex}/${rotated.plaintext}`,
    };
  });

  // ── Provider signing-secret management (ADR-0078) ──────────────────────────────────────────────
  handlers.set(endpointsAddProviderSecret.name, async (ctx, input) => {
    ensureScope(ctx, endpointsAddProviderSecret); // FIRST — sole authz gate on mcp
    // safeParse enforces the contract input — INCLUDING the standard_webhooks secret-format refinement
    // (whsec_+valid-base64, validated with the same decoder the verify path uses). A mis-stored SW
    // secret is rejected here rather than verifying as NO_MATCHING_KEY forever. Surface the failing
    // issue's message (e.g. "a standard_webhooks secret must be whsec_ followed by standard base64") so
    // the operator can self-correct — the messages are fixed strings, never the secret value.
    const parsed = endpointsAddProviderSecret.input.safeParse(input);
    if (!parsed.success) {
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    }
    const evict = requireEvictor();
    const sealer = requireSealer();
    // The endpoint must exist (this org's) before we seal/insert — a clean NOT_FOUND and the hash to
    // evict. (The provider_secrets FK would also reject a bad endpoint, but as a 500, not a 404.)
    const tokenHash = await getEndpointIngestTokenHash(
      deps.tenant,
      ctx.orgId,
      parsed.data.endpointId,
    );
    if (tokenHash === null) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
    const added = await addProviderSecret(
      deps.tenant,
      {
        orgId: ctx.orgId,
        endpointId: parsed.data.endpointId,
        provider: parsed.data.provider,
        label: parsed.data.label,
        // A verify-token (Meta hub.verify_token, ADR-0086) and a braintree public key (bt_challenge
        // handshake) are each sealed as a TYPED blob so the engine can tell them, at unseal, from a signing
        // secret under the same provider slug; a signing secret is sealed as-is. All are opaque ciphertext
        // at rest — never persisted/returned as plaintext.
        plaintext:
          parsed.data.kind === "verify_token"
            ? serializeVerifyTokenSecret(parsed.data.secret)
            : parsed.data.kind === "braintree_public_key"
              ? serializeBraintreePublicKey(parsed.data.secret)
              : parsed.data.secret,
      },
      sealer,
      { auditKey: deps.auditKey, actor: ctx.userId ?? null }, // wha1 provider_secret.added, in-tx
    );
    // Evict so the new secret is honored on the NEXT ingest, not after the KV TTL. Best-effort.
    await evict(tokenHash);
    return { id: added.id, provider: added.provider, status: added.status };
  });

  handlers.set(endpointsListProviderSecrets.name, async (ctx, input) => {
    ensureScope(ctx, endpointsListProviderSecrets); // endpoints:read
    const parsed = endpointsListProviderSecrets.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    // Metadata only — listEndpointProviderSecrets SELECTs no ciphertext, so the sealed bytes/plaintext
    // never leave the DB. Not paginated (a human-managed handful per endpoint): return the whole set.
    const items = await listEndpointProviderSecrets(deps.tenant, ctx.orgId, parsed.data.endpointId);
    return { items };
  });

  handlers.set(endpointsRevokeProviderSecret.name, async (ctx, input) => {
    ensureScope(ctx, endpointsRevokeProviderSecret); // FIRST — sole authz gate on mcp
    const parsed = endpointsRevokeProviderSecret.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const evict = requireEvictor();
    // The revoke and the ingest-token-hash lookup are independent (the hash needs only org+endpoint,
    // both known up front), so run them concurrently rather than serializing two round-trips. The
    // revoke also appends the wha1 provider_secret.revoked row in-tx (only on a real transition). The
    // hash lookup is BEST-EFFORT: the revoke is the durable, security-relevant act — if the (concurrent)
    // hash read fails, fall back to null so we still 200 a successful revoke instead of throwing a 5xx
    // that would (a) mislead the operator into thinking the revoke didn't happen and (b) make a retry
    // hit NOT_FOUND. Eviction itself (ADR-0015) is best-effort over the KV TTL backstop either way.
    const [revoked, tokenHash] = await Promise.all([
      revokeProviderSecret(
        deps.tenant,
        { orgId: ctx.orgId, endpointId: parsed.data.endpointId, secretId: parsed.data.secretId },
        { auditKey: deps.auditKey, actor: ctx.userId ?? null },
      ),
      getEndpointIngestTokenHash(deps.tenant, ctx.orgId, parsed.data.endpointId).catch((err) => {
        console.log(
          JSON.stringify({
            message: "provider_secret.revoke_evict_lookup_failed",
            error: String(err),
          }),
        );
        return null;
      }),
    ]);
    if (revoked === null) throw new CapabilityFault("NOT_FOUND", "provider secret not found");
    // Drop the endpoint's cached principal so the verify path stops honoring the revoked secret NOW,
    // not within the KV TTL. endpointId is authoritative (the revoke is endpoint-scoped).
    if (tokenHash !== null) await evict(tokenHash);
    return { id: revoked.id, revokedAt: revoked.revokedAt };
  });

  return handlers;
}

/**
 * The single source of the read+write capability-handler map. Both apps/api and apps/mcp call this so
 * the merge can't drift between surfaces (the parity invariant the dispatch rests on). Reads ignore the
 * write-only deps and vice versa (structural typing); a new handler family is added here once.
 */
export function buildCapabilityHandlers(
  deps: ReadHandlerDeps & WriteHandlerDeps,
): CapabilityHandlers {
  return new Map([...createReadHandlers(deps), ...createWriteHandlers(deps)]);
}
