// A4b — the RFC 8628 device-code grant for the frozen /token endpoint (pure logic, injected seams).
//
// The provider has no device grant, so this is fully Lane C: poll the device-code store (A4a), and on an
// approved code mint a first-party whk_ directly (mintScopedKey, authMethod "device_code") + a refresh
// handle — exactly like the auth-code path, minus the provider unwrap/revoke (there is no provider grant).
// The non-approved poll states map to the RFC 8628 §3.5 polling responses (authorization_pending /
// slow_down / expired_token / access_denied).
//
// Tenancy: the approved record's props (org/user/scopes/audience) were stamped by the consent approval
// (A4c's setDeviceDecision). Since Lane 2.4b the org is PICKED on the consent screen (validated there
// against the orgs sealed in the ticket) rather than DERIVED from the approver — so membership is no longer
// true "by construction", and this core re-asserts it at the mint (isOrgMember), exactly like the auth-code
// path. It also keeps the audience/scope defense-in-depth (never widen past capability, never mint blank).

import type { OrgIdentity } from "@webhook-co/contract";

import type { PollResult } from "./device-store";
import {
  resolveOrgForTokenBody,
  type MintInput,
  type MintResult,
  type OAuthErrorCode,
  type RedeemResult,
} from "./token-core";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceTokenRequest {
  grant_type: typeof DEVICE_GRANT_TYPE;
  device_code: string;
  client_id: string;
}

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** Injected seams for the device-code redemption + mint. */
export interface DeviceTokenDeps {
  allowedAudiences: readonly string[];
  allowedScopes: readonly string[];
  /**
   * The tenancy bind: is the approver STILL a member of the org the consent recorded? Mirrors the auth-code
   * path (token-core). Required since Lane 2.4b — see the header note.
   */
  isOrgMember: (userId: string, orgId: string) => Promise<boolean>;
  keyTtlSeconds: number;
  /** Poll + consume the device-code store (A4a pollDeviceCode). */
  poll: (deviceCode: string) => Promise<PollResult>;
  /** Mint the first-party whk_ against the grant lifecycle (authMethod "device_code"). */
  mintScopedKey: (input: MintInput) => Promise<MintResult>;
  /** Issue Lane C's opaque ~90d refresh handle, bound to the grant's org + audience. */
  issueRefreshToken: (grantId: string, orgId: string, audience: string) => Promise<string>;
  /** Compensation: revoke a just-minted grant/key if issuance can't complete. */
  rollbackMint: (grantId: string, orgId: string) => Promise<void>;
  /** Best-effort org-identity resolve for the response `organization` field (optional; see FrozenTokenBody). */
  resolveOrgIdentity?: (orgId: string) => Promise<OrgIdentity | null>;
  /** Interval (seconds) advertised on a still-pending org-approval (dormant in v1). */
  defaultPendingInterval: number;
  log?: LogFn;
}

function intersect(base: readonly string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return [...new Set(base.filter((s) => set.has(s)))];
}

function err(error: OAuthErrorCode, description?: string): RedeemResult {
  return { kind: "error", error, ...(description ? { description } : {}) };
}

/**
 * Redeem a device code (RFC 8628 §3.4). Non-approved poll states become the §3.5 polling responses; an
 * approved code mints. The device code is single-use — `poll` consumes it (delete-on-read) when approved,
 * so a replay returns `expired_token`.
 */
export async function redeemDeviceCode(
  deps: DeviceTokenDeps,
  req: DeviceTokenRequest,
): Promise<RedeemResult> {
  const polled = await deps.poll(req.device_code);
  switch (polled.kind) {
    case "pending":
      return err("authorization_pending");
    case "slow_down":
      return err("slow_down");
    case "denied":
      return err("access_denied", "the authorization request was denied");
    case "invalid":
      // Unknown or expired (the store can't distinguish) — tell the client to restart.
      return err("expired_token", "the device code has expired");
    case "approved":
      break;
    default: {
      const _never: never = polled;
      return _never;
    }
  }

  const { props } = polled;
  // Defense in depth (the approval path already constrained these): audience must be a known resource, and
  // the minted scope can only narrow to capability — never blank, never widened.
  if (!props.audience || !deps.allowedAudiences.includes(props.audience)) {
    return err("invalid_target", "audience not permitted");
  }
  const scopes = intersect(props.scopes, deps.allowedScopes);
  if (scopes.length === 0) {
    return err("invalid_scope", "no permitted scope to mint");
  }

  // TENANCY BIND. Consent recorded an org; re-assert membership at the MINT, because the two are separated
  // in time — a user can be removed from the org between approving on their phone and the device polling.
  // Mirrors token-core's auth-code check. Before Lane 2.4b this path relied on the org being DERIVED from
  // the approver (so membership was true by construction); now the org is PICKED, so that argument is gone
  // and the check has to be real. (A removed member is also stopped by the mint ceiling collapsing to zero
  // scopes — but that is a scope mechanism two packages away, load-bearing by accident. This is the gate.)
  if (!(await deps.isOrgMember(props.userId, props.orgId))) {
    deps.log?.("issuer.device.not_org_member", { grant_type: "device_code" });
    return err("access_denied", "user is not a member of the grant org");
  }

  // The mint ceiling normally narrows; it throws only when the user's role can grant NOTHING that was asked
  // for (a member device-authorizing a client that wants solely `billing:read`). That is invalid_scope, not
  // a server fault — letting it escape would 500 the poll after the device code is already consumed.
  let minted: MintResult;
  try {
    minted = await deps.mintScopedKey({
      orgId: props.orgId,
      userId: props.userId,
      scopes,
      audience: props.audience,
      ttlSeconds: deps.keyTtlSeconds,
      device: props.device,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "MintCeilingError") {
      return { kind: "error", error: "invalid_scope", description: "no permitted scope to mint" };
    }
    throw error;
  }

  // Org-level device-approval policy (dormant in v1) — surface as authorization_pending, mint nothing.
  if (minted.status === "pending_approval") {
    return { kind: "pending", grantId: minted.grantId, interval: deps.defaultPendingInterval };
  }

  // Issue the refresh handle before returning; roll the key back if it can't be issued so nothing orphans.
  let refreshToken: string;
  try {
    refreshToken = await deps.issueRefreshToken(minted.grantId, props.orgId, props.audience);
  } catch {
    try {
      await deps.rollbackMint(minted.grantId, props.orgId);
    } catch {
      // Same event name as the auth-code path so one observability query catches every orphaned-mint.
      deps.log?.("issuer.mint_rollback_failed", {
        grant_type: "device_code",
        grantId: minted.grantId,
        reapRequired: true,
      });
    }
    return err("server_error", "could not complete token issuance");
  }

  deps.log?.("issuer.token.minted", {
    grant_type: "device_code",
    grantId: minted.grantId,
    keyId: minted.keyId,
    audience: props.audience,
    scopeCount: scopes.length,
  });

  const organization = await resolveOrgForTokenBody(deps.resolveOrgIdentity, props.orgId, deps.log);

  return {
    kind: "token",
    body: {
      access_token: minted.plaintext,
      token_type: "Bearer",
      expires_in: deps.keyTtlSeconds,
      refresh_token: refreshToken,
      // What the key ACTUALLY carries — the ceiling may have narrowed it. See token-core.
      scope: minted.scopes.join(" "),
      resource: props.audience,
      ...(organization ? { organization } : {}),
    },
  };
}

export { DEVICE_GRANT_TYPE };
