// A2a — the Option-B `/token` redemption + mint cores (pure logic, injected seams).
//
// These are the spine of Lane C's issuer (ADR-0010 r5/r7 + lane-c plan §2/§10). The literal
// "/token returns a whk_" is impossible — `@cloudflare/workers-oauth-provider` claims its own
// `tokenEndpoint` before the default handler, with no token-body hook — so Lane C runs "two token
// endpoints" (Option B): the provider validates the PKCE auth-code server-side, then Lane C unwraps
// the opaque grant, mints a first-party `whk_` against the existing grant lifecycle, kills the
// provider's vestigial grant, and returns the frozen body below.
//
// This module is intentionally I/O-free: every external effect (provider exchange/unwrap/revoke, the
// mint, membership lookup, the refresh-token store) is an injected dependency, so the security
// invariants are unit-testable with fakes and the same cores mount unchanged in A2b. The invariants
// these functions enforce:
//   - audience comes ONLY from the consent-recorded grant props (or, on refresh, the grant's stored
//     audience), never the request body, and must be one of the allowed resources (never blank);
//   - scope can only ever narrow — minted = (consent|requested) ∩ grant-consented ∩ capability — on
//     BOTH the first-issuance and refresh paths, and an empty result is rejected, never minted blank;
//   - the grant's org must be one the consenting user belongs to (tenancy bind);
//   - the provider grant is revoked after a successful mint (its opaque access+refresh die), best-effort
//     so a revoke failure can't orphan the client's just-issued credentials;
//   - a refresh token is consumed (atomically marked used) BEFORE minting, so a concurrent replay can
//     never mint a second key; a mint that can't complete is rolled back so nothing is left orphaned;
//   - no token material (access/refresh token, auth code, PKCE verifier, opaque token) is ever logged
//     or echoed back in an error.

/** The frozen `/token` response body — the C↔D contract (lane-c plan §10). Exactly these fields. */
export interface FrozenTokenBody {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  resource: string;
}

/** OAuth 2.0 error codes this core emits (RFC 6749 §5.2 / RFC 8707 §2). */
export type OAuthErrorCode =
  | "invalid_grant"
  | "invalid_target"
  | "invalid_scope"
  | "invalid_request"
  | "access_denied"
  | "server_error";

export type RedeemResult =
  | { kind: "token"; body: FrozenTokenBody }
  /** Dormant in v1 — approval defaults off, so this branch is contract-only until enabled. */
  | { kind: "pending"; grantId: string; interval: number }
  | { kind: "error"; error: OAuthErrorCode; description?: string };

/** Consent-recorded mint inputs, stashed in the provider grant's encrypted `props` at `/authorize`. */
export interface ConsentProps {
  orgId: string;
  userId: string;
  scopes: string[];
  audience: string;
  device?: { name?: string };
}

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

interface MintInput {
  orgId: string;
  userId: string;
  scopes: string[];
  audience: string;
  ttlSeconds: number;
  device?: { name?: string };
}

type MintResult =
  | { status: "minted"; grantId: string; plaintext: string; keyId: string; expiresAt: Date }
  | { status: "pending_approval"; grantId: string };

export interface AuthCodeRequest {
  grant_type: "authorization_code";
  code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
  resource: string;
}

/** Injected seams for the authorization-code redemption + mint (the provider, the mint, the stores). */
export interface AuthCodeDeps {
  allowedAudiences: readonly string[];
  /** The capability scope set (Lane B `CAPABILITY_SCOPES`). Mints are intersected against this. */
  allowedScopes: readonly string[];
  keyTtlSeconds: number;
  /** Subrequest the provider's own `/oauth/token` (validates PKCE-S256 + single-use in-library). */
  exchangeAuthCode: (
    req: AuthCodeRequest,
  ) => Promise<
    { ok: true; opaque: string } | { ok: false; error: OAuthErrorCode; description?: string }
  >;
  /** Decrypt the provider's opaque token → its grant id + consent props (null = invalid/expired). */
  unwrapToken: (opaque: string) => Promise<{ providerGrantId: string; props: ConsentProps } | null>;
  /** Revoke the provider's grant (G1) — kills the now-vestigial opaque access + refresh tokens. */
  revokeProviderGrant: (providerGrantId: string) => Promise<void>;
  /** Compensation: revoke a just-minted Lane C grant/key if the issuance can't be completed. */
  rollbackMint: (grantId: string) => Promise<void>;
  /** Tenancy bind: is the consenting user a member of the grant's org? */
  isOrgMember: (userId: string, orgId: string) => Promise<boolean>;
  /** Mint the first-party `whk_` against the grant lifecycle (may return pending_approval). */
  mintScopedKey: (input: MintInput) => Promise<MintResult>;
  /** Issue Lane C's own opaque ~90d refresh handle, stored hashed + bound to the Lane C grant. */
  issueRefreshToken: (grantId: string) => Promise<string>;
  defaultPendingInterval: number;
  log?: LogFn;
}

export interface RefreshRequest {
  grant_type: "refresh_token";
  refresh_token: string;
  client_id: string;
  resource: string;
  scope?: string;
}

/** Injected seams for the silent refresh re-mint. */
export interface RefreshDeps {
  allowedAudiences: readonly string[];
  allowedScopes: readonly string[];
  keyTtlSeconds: number;
  /**
   * Atomically consume the presented refresh token: mark it used and return its grant + a replacement
   * refresh token, in one step. Returns null if the token is unknown or was already consumed (replay) —
   * this is the single-use gate, so it MUST run before any mint.
   */
  consumeRefresh: (
    refreshToken: string,
  ) => Promise<{ grantId: string; orgId: string; audience: string; newRefresh: string } | null>;
  /** The scopes the grant was originally consented for (its child api_keys rows). */
  listGrantScopes: (grantId: string) => Promise<string[]>;
  mintKeyForGrant: (input: { grantId: string; scopes: string[]; ttlSeconds: number }) => Promise<{
    plaintext: string;
    keyId: string;
    expiresAt: Date;
  }>;
  log?: LogFn;
}

function parseScopeList(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * Order-preserving, de-duplicated intersection over `base`, keeping only members present in every
 * `filters` set. De-duplication means duplicate/whitespace-padded requested scopes can't bloat the
 * minted set or the response.
 */
function intersectScopes(base: string[], ...filters: ReadonlyArray<readonly string[]>): string[] {
  const sets = filters.map((f) => new Set(f));
  return [...new Set(base.filter((s) => sets.every((set) => set.has(s))))];
}

/**
 * Redeem an authorization code for a first-party `whk_` (Option B). Validates the code via the provider,
 * enforces the audience / scope / tenancy invariants, mints, then assembles the client artifacts before
 * the irreversible provider-grant kill. The provider's opaque token never reaches the caller and is
 * never logged.
 */
export async function redeemAuthCode(
  deps: AuthCodeDeps,
  req: AuthCodeRequest,
): Promise<RedeemResult> {
  const exchanged = await deps.exchangeAuthCode(req);
  if (!exchanged.ok) {
    // Never forward the provider's free-text description to the caller — it may carry internal detail.
    return {
      kind: "error",
      error: exchanged.error,
      description: "authorization grant could not be exchanged",
    };
  }

  const unwrapped = await deps.unwrapToken(exchanged.opaque);
  if (!unwrapped) {
    return { kind: "error", error: "invalid_grant", description: "grant could not be resolved" };
  }
  const { providerGrantId, props } = unwrapped;

  // Audience comes ONLY from consent — never the request body — and must be a known resource.
  if (!props.audience || !deps.allowedAudiences.includes(props.audience)) {
    return { kind: "error", error: "invalid_target", description: "audience not permitted" };
  }

  // Tenancy bind: the grant's org must be one the consenting user actually belongs to.
  if (!(await deps.isOrgMember(props.userId, props.orgId))) {
    return {
      kind: "error",
      error: "access_denied",
      description: "user is not a member of the grant org",
    };
  }

  // Defense in depth: even though consent recorded these scopes, never mint anything outside capability.
  const scopes = intersectScopes(props.scopes, deps.allowedScopes);
  if (scopes.length === 0) {
    return { kind: "error", error: "invalid_scope", description: "no permitted scope to mint" };
  }

  const minted = await deps.mintScopedKey({
    orgId: props.orgId,
    userId: props.userId,
    scopes,
    audience: props.audience,
    ttlSeconds: deps.keyTtlSeconds,
    device: props.device,
  });

  if (minted.status === "pending_approval") {
    return { kind: "pending", grantId: minted.grantId, interval: deps.defaultPendingInterval };
  }

  // The key is now live. Issue the refresh token (the last client-facing artifact) BEFORE the
  // irreversible provider-grant kill. If it can't be issued, roll the minted key back so nothing is
  // left orphaned, and report failure.
  let refreshToken: string;
  try {
    refreshToken = await deps.issueRefreshToken(minted.grantId);
  } catch {
    try {
      await deps.rollbackMint(minted.grantId);
    } catch {
      deps.log?.("issuer.mint_rollback_failed", { grantId: minted.grantId, reapRequired: true });
    }
    return {
      kind: "error",
      error: "server_error",
      description: "could not complete token issuance",
    };
  }

  // G1: kill the provider's now-vestigial grant (its opaque access+refresh). Best-effort — the opaque
  // token was never delivered to the caller, so a revoke failure only leaves a server-side grant to be
  // reaped; failing the whole request here would orphan the client's just-issued credentials.
  try {
    await deps.revokeProviderGrant(providerGrantId);
  } catch {
    deps.log?.("issuer.provider_grant_revoke_failed", {
      providerGrantId,
      keyId: minted.keyId,
      reapRequired: true,
    });
  }

  deps.log?.("issuer.token.minted", {
    grant_type: "authorization_code",
    grantId: minted.grantId,
    keyId: minted.keyId,
    audience: props.audience,
    scopeCount: scopes.length,
  });

  return {
    kind: "token",
    body: {
      access_token: minted.plaintext,
      token_type: "Bearer",
      // The mint is asked for exactly keyTtlSeconds, so expires_in equals it by construction.
      expires_in: deps.keyTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      resource: props.audience,
    },
  };
}

/**
 * Silent refresh: re-mint a fresh `whk_` on an existing grant. The presented refresh token is consumed
 * (single-use) BEFORE minting, so a concurrent replay loses the race and can't mint a second key. Scope
 * can only ever narrow (`requested ∩ grant-consented ∩ capability`); an empty result is rejected.
 * Audience is the grant's stored audience, validated against the allow-list, never the request body.
 */
export async function redeemRefresh(deps: RefreshDeps, req: RefreshRequest): Promise<RedeemResult> {
  // Consume first — this is the single-use gate. A replay of an already-used token returns null here
  // and never reaches the mint below.
  const grant = await deps.consumeRefresh(req.refresh_token);
  if (!grant) {
    return { kind: "error", error: "invalid_grant", description: "refresh token not recognized" };
  }

  if (!grant.audience || !deps.allowedAudiences.includes(grant.audience)) {
    return { kind: "error", error: "invalid_target", description: "audience not permitted" };
  }

  const consented = await deps.listGrantScopes(grant.grantId);
  const requested = parseScopeList(req.scope);
  // Absent `scope` ⇒ keep the full consented set; otherwise narrow to the requested subset. Never widen.
  const base = requested.length > 0 ? requested : consented;
  const scopes = intersectScopes(base, consented, deps.allowedScopes);
  if (scopes.length === 0) {
    return { kind: "error", error: "invalid_scope", description: "no permitted scope to mint" };
  }

  const minted = await deps.mintKeyForGrant({
    grantId: grant.grantId,
    scopes,
    ttlSeconds: deps.keyTtlSeconds,
  });

  deps.log?.("issuer.token.refreshed", {
    grant_type: "refresh_token",
    grantId: grant.grantId,
    keyId: minted.keyId,
    audience: grant.audience,
    scopeCount: scopes.length,
  });

  return {
    kind: "token",
    body: {
      access_token: minted.plaintext,
      token_type: "Bearer",
      expires_in: deps.keyTtlSeconds,
      refresh_token: grant.newRefresh,
      scope: scopes.join(" "),
      resource: grant.audience,
    },
  };
}
