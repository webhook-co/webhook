// A4b — the RFC 8628 device-code grant for the frozen /token endpoint (pure logic, injected seams).
//
// The provider has no device grant, so this is fully Lane C: poll the device-code store (A4a), and on an
// approved code mint a first-party whk_ directly (mintScopedKey, authMethod "device_code") + a refresh
// handle — exactly like the auth-code path, minus the provider unwrap/revoke (there is no provider grant).
// The non-approved poll states map to the RFC 8628 §3.5 polling responses (authorization_pending /
// slow_down / expired_token / access_denied).
//
// Tenancy: the approved record's props (org/user/scopes/audience) were stamped by the consent approval
// (A4c's setDeviceDecision), whose org is resolved membership-gated via getConsentOrg(sessionUserId) — so
// props.orgId is always the approver's own org and membership is guaranteed by construction; this core adds
// audience/scope defense-in-depth (never widen past capability, never mint blank) but needs no DB.

import type { PollResult } from "./device-store";
import type { MintInput, MintResult, OAuthErrorCode, RedeemResult } from "./token-core";

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
  keyTtlSeconds: number;
  /** Poll + consume the device-code store (A4a pollDeviceCode). */
  poll: (deviceCode: string) => Promise<PollResult>;
  /** Mint the first-party whk_ against the grant lifecycle (authMethod "device_code"). */
  mintScopedKey: (input: MintInput) => Promise<MintResult>;
  /** Issue Lane C's opaque ~90d refresh handle, bound to the grant's org + audience. */
  issueRefreshToken: (grantId: string, orgId: string, audience: string) => Promise<string>;
  /** Compensation: revoke a just-minted grant/key if issuance can't complete. */
  rollbackMint: (grantId: string, orgId: string) => Promise<void>;
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

  const minted = await deps.mintScopedKey({
    orgId: props.orgId,
    userId: props.userId,
    scopes,
    audience: props.audience,
    ttlSeconds: deps.keyTtlSeconds,
    device: props.device,
  });

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

  return {
    kind: "token",
    body: {
      access_token: minted.plaintext,
      token_type: "Bearer",
      expires_in: deps.keyTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      resource: props.audience,
    },
  };
}

export { DEVICE_GRANT_TYPE };
