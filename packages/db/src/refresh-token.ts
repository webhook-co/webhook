// Lane C A2b-2a — the OAuth refresh-token store (ADR-0024). Issue / atomic-single-use-consume+rotate /
// revoke for the first-party ~90d opaque refresh handle the frozen /token returns alongside the 24h
// whk_ key. The handle is `rtk_<orgId>_<secret>`: the org is a tenant-routing hint (NOT a secret) so the
// issuer resolves the org from the handle and stays on the normal webhook_app RLS scope — no cross-org
// role. The 256-bit secret is the entropy; only its HMAC-SHA256+pepper hash (over the WHOLE plaintext,
// so the embedded org is tamper-covered) is stored. See migration 0017.

import { randomBytes, randomUUID } from "node:crypto";

import { withTenant, type Sql, type TenantTx } from "./client";
import { CREDENTIAL_SECRET_BYTES, type CredentialHasher } from "./credential";

const REFRESH_PREFIX = "rtk";
const START_LEN = 11;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintRefreshTokenInput {
  readonly orgId: string;
  readonly grantId: string;
  readonly audience: string;
  /** Handle lifetime in seconds (~90d). */
  readonly ttlSeconds: number;
}

export interface MintedRefreshToken {
  /** The opaque handle — returned to the client once, never stored. */
  readonly plaintext: string;
  readonly refreshTokenId: string;
  readonly expiresAt: Date;
}

export interface ConsumedRefreshToken {
  readonly grantId: string;
  readonly orgId: string;
  readonly audience: string;
  /** The rotated replacement handle (single-use rotation). */
  readonly newRefresh: string;
}

/** `rtk_<orgId>_<secret>` — the org routes the tenant lookup; the secret (hashed) authenticates it. */
function makeRefreshPlaintext(orgId: string): string {
  const secret = randomBytes(CREDENTIAL_SECRET_BYTES).toString("base64url");
  return `${REFRESH_PREFIX}_${orgId}_${secret}`;
}

/**
 * Extract the embedded org from a refresh handle. Returns null for anything not of our shape (wrong
 * prefix, missing segments, or a non-UUID org segment) — the caller treats that as an unknown token.
 */
export function parseRefreshTokenOrg(plaintext: string): string | null {
  const parts = plaintext.split("_");
  if (parts.length < 3 || parts[0] !== REFRESH_PREFIX) return null;
  const orgId = parts[1];
  return orgId && UUID_RE.test(orgId) ? orgId : null;
}

async function insertRefreshToken(
  tx: TenantTx,
  orgId: string,
  grantId: string,
  audience: string,
  plaintext: string,
  hasher: CredentialHasher,
  ttlSeconds: number,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomUUID();
  const [row] = await tx<{ expires_at: Date }[]>`
    insert into auth_refresh_token
      (id, org_id, grant_id, audience, token_hash, prefix, start, expires_at)
    values
      (${id}, ${orgId}, ${grantId}, ${audience}, ${hasher.hash(plaintext)}, ${REFRESH_PREFIX},
       ${plaintext.slice(0, START_LEN)}, now() + make_interval(secs => ${ttlSeconds}))
    returning expires_at`;
  if (!row) throw new Error("insertRefreshToken: insert returned no row");
  return { id, expiresAt: row.expires_at };
}

/** Issue a fresh refresh handle bound to a grant + its audience (called right after a /token mint). */
export async function mintRefreshToken(
  app: Sql,
  input: MintRefreshTokenInput,
  hasher: CredentialHasher,
): Promise<MintedRefreshToken> {
  const plaintext = makeRefreshPlaintext(input.orgId);
  const { id, expiresAt } = await withTenant(app, input.orgId, (tx) =>
    insertRefreshToken(
      tx,
      input.orgId,
      input.grantId,
      input.audience,
      plaintext,
      hasher,
      input.ttlSeconds,
    ),
  );
  return { plaintext, refreshTokenId: id, expiresAt };
}

/**
 * Atomically consume a refresh handle and rotate it. Returns the grant context + a replacement handle,
 * or null if the handle is unknown / already used / expired / revoked, or its grant is no longer active
 * OR is itself past its expiry (the grant-lifetime ceiling the consent screen advertises — a refresh can
 * never outlive the grant). The single-use gate is the one UPDATE…FROM auth_grant below: a replay loses
 * the row lock and matches no row, so it can never mint a second key. Consume + rotate run in one
 * transaction (withTenant). The lookup uses candidates() (current + previous peppers) so outstanding
 * ~90d handles survive a pepper rotation, mirroring the api-key verify path.
 */
export async function consumeRefreshToken(
  app: Sql,
  plaintext: string,
  hasher: CredentialHasher,
  ttlSeconds: number,
): Promise<ConsumedRefreshToken | null> {
  const orgId = parseRefreshTokenOrg(plaintext);
  if (!orgId) return null;
  return withTenant(app, orgId, async (tx) => {
    // Try each pepper candidate (current, then previous) — a handle was stored under exactly one, so at
    // most one matches. Iterating mirrors the api-key cold-lookup (postgres.js doesn't bind a Buffer[]
    // as bytea[] for `= any()`); the first match's UPDATE is the atomic single-use gate.
    let consumed: { id: string; grant_id: string; audience: string } | undefined;
    for (const candidate of hasher.candidates(plaintext)) {
      [consumed] = await tx<{ id: string; grant_id: string; audience: string }[]>`
        update auth_refresh_token rt set used_at = now()
        from auth_grant g
        where rt.token_hash = ${candidate}
          and rt.grant_id = g.id and rt.org_id = g.org_id
          and rt.used_at is null and rt.revoked_at is null and rt.expires_at > now()
          and g.status = 'active' and (g.expires_at is null or g.expires_at > now())
        returning rt.id, rt.grant_id, rt.audience`;
      if (consumed) break;
    }
    if (!consumed) return null;

    const next = makeRefreshPlaintext(orgId);
    const { id: newId } = await insertRefreshToken(
      tx,
      orgId,
      consumed.grant_id,
      consumed.audience,
      next,
      hasher,
      ttlSeconds,
    );
    await tx`update auth_refresh_token set replaced_by = ${newId} where id = ${consumed.id}`;
    return { grantId: consumed.grant_id, orgId, audience: consumed.audience, newRefresh: next };
  });
}

/**
 * Resolve a presented `rtk_` refresh handle to its PARENT GRANT — for the issuer's RFC 7009 /revoke
 * (Lane C A2b-4). The handle embeds its org, so this stays on the normal webhook_app RLS scope (no
 * cross-org role, unlike the whk_ path). Does NOT filter used/revoked/expired: /revoke must find the grant
 * even for a spent handle so it can still kill the (possibly-live) grant; revokeGrant is idempotent. Loops
 * pepper candidates. Returns null for a malformed handle or an unknown hash.
 */
export async function findRefreshTokenGrant(
  app: Sql,
  plaintext: string,
  hasher: CredentialHasher,
): Promise<{ orgId: string; grantId: string } | null> {
  const orgId = parseRefreshTokenOrg(plaintext);
  if (!orgId) return null;
  return withTenant(app, orgId, async (tx) => {
    for (const candidate of hasher.candidates(plaintext)) {
      const [row] = await tx<{ grant_id: string }[]>`
        select grant_id from auth_refresh_token where token_hash = ${candidate}`;
      if (row) return { orgId, grantId: row.grant_id };
    }
    return null;
  });
}

/**
 * Revoke every still-live (unused, unrevoked) refresh handle of a grant so none can be consumed —
 * called when a grant is revoked (A2b-4). Returns the count revoked. Used handles are already spent.
 */
export async function revokeRefreshTokensForGrant(
  app: Sql,
  { orgId, grantId }: { orgId: string; grantId: string },
): Promise<number> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ id: string }[]>`
        update auth_refresh_token set revoked_at = now()
        where grant_id = ${grantId} and revoked_at is null and used_at is null
        returning id`,
  );
  return rows.length;
}
