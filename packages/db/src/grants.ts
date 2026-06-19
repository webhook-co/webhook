// Grant + scoped-key issuance (Lane B A0c). The credential ISSUANCE side of ADR-0010 r5/r7: an OAuth
// login mints a scoped, grant-backed `whk_` key (NOT an opaque token). A grant (auth_grant) is the
// device-authorization a key hangs off; a minted key writes the first-party api_keys table the
// resolver reads (r7). Every mint is ATOMIC — grant + key + audit rows in ONE transaction — and every
// state change appends to the aae1 control-plane chain (auth-audit.ts) under the audit HMAC key.
//
// Approval model (org_policy.require_device_approval, default OFF):
//   - OFF: a login mints an active grant + key immediately.
//   - ON:  evaluateAutoApprove(auto_approve_rules, ctx) — a match mints an auto-approved grant + key;
//          no match creates a pending_approval grant with NO key (a human/device approves later).
// Refresh (Lane C grant_type=refresh_token) re-mints a fresh key on the EXISTING active grant
// (mintKeyForGrant) — the prior key expires naturally (≤ its TTL); no new grant.

import { randomUUID } from "node:crypto";

import { insertApiKey } from "./api-keys";
import { withTenant, type Sql, type TenantTx } from "./client";
import { type CredentialHasher } from "./credential";
import { appendAuthAuditEntry } from "./auth-audit";
import { evaluateAutoApprove, type AutoApproveContext } from "./auto-approve";

export type GrantStatus = "pending_approval" | "active" | "revoked" | "expired";
export type AuthMethod = "pkce_loopback" | "device_code";
export type OwnerType = "user" | "org";

/** Default display name for a minted device key when the caller gives none. */
const DEFAULT_KEY_NAME = "device";

/** Device/login context recorded on the grant + fed to the auto-approve evaluator. */
export interface DeviceInfo {
  readonly name?: string | null;
  readonly fingerprint?: string | null;
  readonly ip?: string | null;
  /** jsonb geo (e.g. { country, region }). `country` is read for the auto-approve geo allow-list. */
  readonly geo?: unknown;
}

/** A minted key handed back to the caller — the plaintext is shown ONCE. */
export interface MintedKey {
  readonly plaintext: string;
  readonly keyId: string;
  readonly expiresAt: Date;
}

export interface MintScopedKeyInput {
  readonly orgId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly audience: string;
  /** Key TTL in seconds (the minted whk_ key's lifetime; ~24h). */
  readonly ttlSeconds: number;
  readonly authMethod: AuthMethod;
  readonly device?: DeviceInfo;
  readonly ownerType?: OwnerType;
  readonly keyName?: string;
  /** Grant lifetime in seconds (~refresh-token lifetime). Omitted = no grant expiry. */
  readonly grantTtlSeconds?: number;
  /** Whether the login was SSO-verified (an auto-approve signal). */
  readonly ssoVerified?: boolean;
  readonly ssoIdentityId?: string | null;
}

export type MintScopedKeyResult =
  | ({ readonly status: "minted"; readonly grantId: string } & MintedKey)
  | { readonly status: "pending_approval"; readonly grantId: string };

export interface MintKeyForGrantInput {
  readonly orgId: string;
  readonly grantId: string;
  readonly scopes: readonly string[];
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly keyName?: string;
  readonly ownerType?: OwnerType;
}

export interface CreatePendingGrantInput {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: AuthMethod;
  readonly device?: DeviceInfo;
  readonly grantTtlSeconds?: number;
  readonly ssoIdentityId?: string | null;
}

export interface ApproveGrantInput {
  readonly orgId: string;
  readonly grantId: string;
  /** The user_id approving (a human admin), or null for a system/auto approval. */
  readonly approvedBy?: string | null;
  readonly scopes: readonly string[];
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly keyName?: string;
  readonly ownerType?: OwnerType;
}

/** Build the auto-approve evaluator context from the device/login signals. */
function approvalContext(input: MintScopedKeyInput): AutoApproveContext {
  const geo = input.device?.geo;
  const country =
    geo !== null && typeof geo === "object" && "country" in geo
      ? (geo as { country?: unknown }).country
      : undefined;
  return {
    ip: input.device?.ip ?? null,
    geoCountry: typeof country === "string" ? country : null,
    ssoVerified: input.ssoVerified,
  };
}

interface InsertGrantFields {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: AuthMethod;
  readonly status: GrantStatus;
  readonly device?: DeviceInfo;
  readonly expiresAt?: Date | null;
  readonly ssoIdentityId?: string | null;
  readonly approvedBy?: string | null;
  readonly approvedAt?: Date | null;
}

/** Insert an auth_grant row inside the caller's tenant tx; returns the new grant id. */
async function insertGrant(tx: TenantTx, f: InsertGrantFields): Promise<string> {
  const id = randomUUID();
  const geo = f.device?.geo;
  await tx`
    insert into auth_grant
      (id, org_id, user_id, status, auth_method, device_name, device_fingerprint,
       created_ip, created_geo, sso_identity_id, expires_at, approved_by, approved_at)
    values
      (${id}, ${f.orgId}, ${f.userId}, ${f.status}, ${f.authMethod},
       ${f.device?.name ?? null}, ${f.device?.fingerprint ?? null}, ${f.device?.ip ?? null},
       ${geo == null ? null : tx.json(geo as Parameters<typeof tx.json>[0])}::jsonb,
       ${f.ssoIdentityId ?? null}, ${f.expiresAt ?? null}, ${f.approvedBy ?? null},
       ${f.approvedAt ?? null})`;
  return id;
}

/** Insert a pending_approval grant + its grant_created audit row in the caller's tx; returns the id. */
async function insertPendingGrantInTx(
  tx: TenantTx,
  input: CreatePendingGrantInput,
  auditKey: CryptoKey,
): Promise<string> {
  const grantId = await insertGrant(tx, {
    orgId: input.orgId,
    userId: input.userId,
    authMethod: input.authMethod,
    status: "pending_approval",
    device: input.device,
    expiresAt:
      input.grantTtlSeconds != null ? new Date(Date.now() + input.grantTtlSeconds * 1000) : null,
    ssoIdentityId: input.ssoIdentityId,
  });
  await appendAuthAuditEntry(tx, auditKey, {
    orgId: input.orgId,
    actor: input.userId,
    eventType: "grant_created",
    targetId: grantId,
    ip: input.device?.ip,
    geo: input.device?.geo,
    metadata: { authMethod: input.authMethod, status: "pending_approval" },
  });
  return grantId;
}

/** Mint a key under an existing grant + write its key_minted audit, all in the caller's tx. */
async function mintKeyOnGrantInTx(
  tx: TenantTx,
  input: MintKeyForGrantInput,
  actorUserId: string | null,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<MintedKey> {
  // Defensive guard: a non-positive TTL would mint a pre-expired (instantly-dead) key. Callers
  // (Lane C) own the policy clamp (max_credential_ttl etc.); this is the last line before persistence.
  if (!(input.ttlSeconds > 0)) {
    throw new Error("mint: ttlSeconds must be a positive number");
  }
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const key = await insertApiKey(
    tx,
    {
      orgId: input.orgId,
      name: input.keyName ?? DEFAULT_KEY_NAME,
      scopes: input.scopes,
      expiresAt,
      grantId: input.grantId,
      audience: input.audience,
      ownerType: input.ownerType,
    },
    hasher,
  );
  await appendAuthAuditEntry(tx, auditKey, {
    orgId: input.orgId,
    actor: actorUserId,
    eventType: "key_minted",
    targetId: key.id,
    metadata: { grantId: input.grantId, audience: input.audience },
  });
  return { plaintext: key.plaintext, keyId: key.id, expiresAt };
}

/**
 * Mint a scoped, grant-backed key for a login. Atomic (grant + key + audit in one tx). When the org
 * requires device approval and the request does NOT auto-approve, creates a pending_approval grant
 * with NO key (status: "pending_approval"); a later approveGrant mints. Otherwise mints an active
 * grant + key (status: "minted"). The plaintext is returned once.
 */
export async function mintScopedKey(
  app: Sql,
  input: MintScopedKeyInput,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<MintScopedKeyResult> {
  return withTenant(app, input.orgId, async (tx) => {
    const [policy] = await tx<
      { require_device_approval: boolean | null; auto_approve_rules: unknown }[]
    >`
      select require_device_approval, auto_approve_rules from org_policy where org_id = ${input.orgId}`;
    const approvalRequired = policy?.require_device_approval === true;
    const autoApproved = approvalRequired
      ? evaluateAutoApprove(policy?.auto_approve_rules, approvalContext(input))
      : false;

    const grantExpiresAt =
      input.grantTtlSeconds != null ? new Date(Date.now() + input.grantTtlSeconds * 1000) : null;

    if (approvalRequired && !autoApproved) {
      const grantId = await insertPendingGrantInTx(
        tx,
        {
          orgId: input.orgId,
          userId: input.userId,
          authMethod: input.authMethod,
          device: input.device,
          grantTtlSeconds: input.grantTtlSeconds,
          ssoIdentityId: input.ssoIdentityId,
        },
        auditKey,
      );
      return { status: "pending_approval", grantId };
    }

    // Active path: approval OFF, or approval ON and auto-approved.
    const approvedAt = autoApproved ? new Date() : null;
    const grantId = await insertGrant(tx, {
      orgId: input.orgId,
      userId: input.userId,
      authMethod: input.authMethod,
      status: "active",
      device: input.device,
      expiresAt: grantExpiresAt,
      ssoIdentityId: input.ssoIdentityId,
      approvedBy: null, // system / not-required
      approvedAt,
    });
    await appendAuthAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.userId,
      eventType: "grant_created",
      targetId: grantId,
      ip: input.device?.ip,
      geo: input.device?.geo,
      metadata: { authMethod: input.authMethod, status: "active", autoApproved },
    });
    if (autoApproved) {
      // A policy auto-approval is a SYSTEM decision (not the user approving themselves), so the
      // grant_approved actor is null to match the grant's approved_by=null; metadata.auto marks it.
      await appendAuthAuditEntry(tx, auditKey, {
        orgId: input.orgId,
        actor: null,
        eventType: "grant_approved",
        targetId: grantId,
        metadata: { auto: true },
      });
    }
    const minted = await mintKeyOnGrantInTx(
      tx,
      {
        orgId: input.orgId,
        grantId,
        scopes: input.scopes,
        audience: input.audience,
        ttlSeconds: input.ttlSeconds,
        keyName: input.keyName,
        ownerType: input.ownerType,
      },
      input.userId,
      hasher,
      auditKey,
    );
    return { status: "minted", grantId, ...minted };
  });
}

/**
 * Re-mint a fresh key on an EXISTING active grant (the refresh path). Atomic (key + audit). Throws if
 * the grant is missing or not active (a revoked/expired/pending grant must not yield a key). The prior
 * key is NOT revoked — it expires naturally within its TTL (founder decision, ADR-0020 Q3). Stamps the
 * grant's last_used_at (a refresh IS a use of the grant).
 *
 * CONTRACT (caller, Lane C): `scopes`/`audience` MUST be a subset of what the grant was originally
 * consented to. v1 does NOT persist a grant's authorized scope set, so this layer cannot verify the
 * subset — a refresh handler that widens scopes here would escalate. Pass the grant's bound scopes.
 */
export async function mintKeyForGrant(
  app: Sql,
  input: MintKeyForGrantInput,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<MintedKey> {
  return withTenant(app, input.orgId, async (tx) => {
    const [grant] = await tx<{ status: GrantStatus; user_id: string }[]>`
      select status, user_id from auth_grant where id = ${input.grantId}`;
    if (!grant) throw new Error("mintKeyForGrant: grant not found");
    if (grant.status !== "active") {
      throw new Error(`mintKeyForGrant: grant is not active (status=${grant.status})`);
    }
    const minted = await mintKeyOnGrantInTx(tx, input, grant.user_id, hasher, auditKey);
    await tx`update auth_grant set last_used_at = now() where id = ${input.grantId}`;
    return minted;
  });
}

/** Create a pending_approval grant (the device-code start) with NO key. Atomic (grant + audit). */
export async function createPendingGrant(
  app: Sql,
  input: CreatePendingGrantInput,
  auditKey: CryptoKey,
): Promise<{ grantId: string }> {
  return withTenant(app, input.orgId, async (tx) => {
    const grantId = await insertPendingGrantInTx(tx, input, auditKey);
    return { grantId };
  });
}

/**
 * Approve a pending grant and mint its first key. Atomic (grant update + key + 2 audit rows). Throws
 * if the grant is missing or not pending_approval (idempotency/skew guard). Sets status=active +
 * approved_by/approved_at, audits grant_approved, then mints the key (key_minted).
 */
export async function approveGrant(
  app: Sql,
  input: ApproveGrantInput,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<MintedKey> {
  return withTenant(app, input.orgId, async (tx) => {
    const updated = await tx<{ user_id: string }[]>`
      update auth_grant
      set status = 'active', approved_by = ${input.approvedBy ?? null}, approved_at = now()
      where id = ${input.grantId} and status = 'pending_approval'
      returning user_id`;
    const grant = updated[0];
    if (!grant) {
      throw new Error("approveGrant: grant not found or not pending_approval");
    }
    await appendAuthAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.approvedBy ?? null,
      // Derive auto from the approver: a null approvedBy is a system/automated approval, not human.
      // The audit must not record an automated approval as human (it's the tamper-evident record).
      eventType: "grant_approved",
      targetId: input.grantId,
      metadata: { auto: input.approvedBy == null },
    });
    return mintKeyOnGrantInTx(
      tx,
      {
        orgId: input.orgId,
        grantId: input.grantId,
        scopes: input.scopes,
        audience: input.audience,
        ttlSeconds: input.ttlSeconds,
        keyName: input.keyName,
        ownerType: input.ownerType,
      },
      grant.user_id,
      hasher,
      auditKey,
    );
  });
}
