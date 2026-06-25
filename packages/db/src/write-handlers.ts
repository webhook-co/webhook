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
  endpointsCreate,
  type AnyCapability,
  type AuthContext,
} from "@webhook-co/contract";

import type { Sql } from "./client";
import type { CredentialHasher } from "./credential";
import { createEndpointWithAudit } from "./endpoints";
import { createReadHandlers, type CapabilityHandlers, type ReadHandlerDeps } from "./read-handlers";

/** Per-org endpoint soft cap (ADR-0075): an abuse backstop while there is no endpoints.delete. Tunable. */
export const DEFAULT_MAX_ENDPOINTS_PER_ORG = 100;

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

  function ensureScope(ctx: AuthContext, cap: AnyCapability): void {
    if (!ctx.scopes.includes(cap.auth.scope)) {
      throw new CapabilityFault("FORBIDDEN", `missing required scope: ${cap.auth.scope}`);
    }
  }

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
