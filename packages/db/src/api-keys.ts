// API-key lifecycle + the authn cold-path lookup (ADR-0008 Option B).
//
// TWO POOLS, STATED HONESTLY — this is NOT a "switch role" trick:
//   * webhook_app  owns create / list / revoke. These are ordinary tenant DML under
//     RLS, run inside withTenant(app, orgId, ...) so app.current_org pins the org.
//   * webhook_authn owns ONLY the verify cold path: a global-by-hash SELECT of the five
//     granted columns. webhook_authn deliberately CANNOT `SET ROLE webhook_app` (no role
//     membership) — granting that membership would defeat least-privilege. So a verified
//     request that then does per-tenant work uses TWO connections: the tiny authn pool to
//     discover {org_id, scopes} from the key, then the normal webhook_app pool with the
//     tenant context pinned to THAT org. Two round-trips per authenticated request; fine
//     OFF the ingest hot path (the hot path uses the KV cache, see credential-resolver).
//
// CACHING (binding decision): the authn cold lookup is sensitive (a credential-hash ->
// org map) and MUST run through the CACHE-DISABLED Hyperdrive binding (HYPERDRIVE_TENANT
// style), NEVER HYPERDRIVE_CACHED — Hyperdrive's query cache can't be invalidated on
// revocation. The KV layer (credential-resolver) is the only authn cache, because KV
// CAN be invalidated on revoke. The caller wires the authn `Sql` to the uncached binding.

import { randomUUID } from "node:crypto";

import { exceedsMintCeiling } from "@webhook-co/contract/mint-ceiling";
import type { MembershipRole } from "@webhook-co/shared";

import { appendAuthAuditEntry } from "./auth-audit";
import { createClient, withTenant, type Sql, type TenantTx } from "./client";
import { insertNotificationIntent } from "./delivery";
import {
  credentialHashEquals,
  mintChecksummedCredential,
  type CredentialHasher,
} from "./credential";
import type { ResolvedPrincipal } from "./credential-cache";
import { readMembershipRole } from "./orgs";

/** Default display prefix for api keys (the non-secret handle). */
export const API_KEY_PREFIX = "whk";

export interface CreateApiKeyInput {
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date | null;
  /** Grant this key hangs off (A0c). null/omitted = a standalone, directly-created key. */
  readonly grantId?: string | null;
  /** Per-key RFC 8707 audience (A0b). null/omitted = legacy/org-wide (surface-stamped at resolve). */
  readonly audience?: string | null;
  /** Owner type (api_keys.owner_type). Defaults to 'user'. */
  readonly ownerType?: "user" | "org";
  /**
   * The membership role of the human this key is minted UNDER, in `orgId`. REQUIRED — deliberately not
   * optional — because it is the mint ceiling's only input: a key may not grant more than its creator can
   * exercise. Making it required means a mint path added later cannot COMPILE without stating whose
   * authority it mints under; an optional field would default to "unchecked" and the ceiling would rot.
   *
   * `null` = no membership ⇒ the ceiling is empty ⇒ nothing can be minted. That is the correct answer for a
   * caller with no standing in the org, and it fails closed.
   */
  readonly minterRole: MembershipRole | null;
  /**
   * The user this key is attributed to (api_keys.created_by). Null only for a key with no human minter.
   * Offboarding enumerates a departing member's keys by this column — what it cannot find, it cannot revoke.
   */
  readonly createdBy?: string | null;
}

/** A mint that asked for more authority than its minter holds. Carries the offending scopes so the caller
 *  can name them: silently minting a WEAKER key than requested is a bad surprise, and silently minting a
 *  STRONGER one is the escalation this exists to prevent. */
export class MintCeilingError extends Error {
  constructor(readonly deniedScopes: readonly string[]) {
    super(`scopes exceed the minter's authority: ${deniedScopes.join(", ")}`);
    this.name = "MintCeilingError";
  }
}

export interface CreatedApiKey {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly start: string;
  readonly expiresAt: Date | null;
  /** The plaintext key — returned ONCE, never persisted. Surface it to the user now. */
  readonly plaintext: string;
}

/** A row in a key listing: display metadata ONLY — never key_hash or plaintext. */
export interface ApiKeyListItem {
  readonly id: string;
  readonly name: string;
  readonly start: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Create an org-scoped api key. Mints a >=256-bit CSPRNG secret, stores ONLY its keyed
 * HMAC-SHA256 hash (peppered, see credential.ts) plus a non-secret display `start`, and
 * returns the plaintext exactly once. Runs as webhook_app under the org's RLS context. The
 * `hasher` carries the pepper (injected from a secret, never a literal). The edge generates
 * the uuidv7 id (no DB default) — randomUUID() is a stand-in until the shared uuidv7 mint
 * is wired; both are edge-generated uuids, so the storage contract is unchanged.
 */
export async function createApiKey(
  app: Sql,
  input: Omit<CreateApiKeyInput, "minterRole" | "createdBy">,
  hasher: CredentialHasher,
  actorUserId: string | null,
): Promise<CreatedApiKey> {
  const created = await withTenant(app, input.orgId, async (tx) => {
    // Derived here, never accepted from the caller. Taking `minterRole` as a parameter would make the
    // ceiling advisory: a caller could simply assert `minterRole: "owner"` for a member and walk through it.
    // The authority a key is minted under is a FACT about the database, so it is read from the database.
    const minterRole = (await readMembershipRole(
      tx,
      input.orgId,
      actorUserId ?? "",
    )) as MembershipRole | null;
    return insertApiKey(tx, { ...input, minterRole, createdBy: actorUserId }, hasher);
  });
  const { keyHash: _keyHash, ...rest } = created;
  return rest;
}

/**
 * Create a standalone api key AND write its `key_minted` audit row **atomically** in one tenant
 * transaction — the dashboard's create path (a mint must never be silent; the constitution). Unlike
 * {@link createApiKey} (which writes no audit — the grant path owns the audit there), this is the
 * audited standalone mint: insert + append-audit in the same `withTenant` tx, so a crash can't leave a
 * key without its audit entry. `actorUserId` is the consenting user (the session principal). Returns the
 * created key + the one-time plaintext; the keyHash never leaves the package.
 */
export async function createApiKeyWithAudit(
  app: Sql,
  input: Omit<CreateApiKeyInput, "minterRole" | "createdBy">,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
  actorUserId: string | null,
): Promise<CreatedApiKey> {
  const created = await withTenant(app, input.orgId, async (tx) => {
    // The minter's role is read INSIDE the mint transaction, from the acting user's membership in THIS org.
    // Deriving it here rather than trusting a caller-supplied value closes the TOCTOU: a role read before
    // the transaction could have changed by the time the key lands. A caller with no membership reads back
    // null, and the ceiling then permits nothing.
    const minterRole = await readMembershipRole(tx, input.orgId, actorUserId ?? "");
    const key = await insertApiKey(
      tx,
      {
        ...input,
        minterRole: minterRole as MembershipRole | null,
        createdBy: actorUserId,
      },
      hasher,
    );
    await appendAuthAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: actorUserId,
      eventType: "key_minted",
      targetId: key.id,
      // Record the authority the key was minted UNDER, and what it was granted. When this key is later
      // found in a log doing something surprising, the chain answers "who could have done this, and with
      // what standing" — not just "a key existed".
      metadata: {
        grantId: input.grantId ?? null,
        audience: input.audience ?? null,
        minterRole,
        scopes: [...input.scopes],
      },
    });
    return key;
  });
  const { keyHash: _keyHash, ...rest } = created;
  return rest;
}

/**
 * Mint + insert an api_keys row INSIDE the caller's tenant transaction `tx`, returning the created
 * key plus its `keyHash`. This is the tx-level core so a grant-backed mint (grants.ts) can write the
 * key AND its audit row atomically in one transaction; createApiKey wraps it in its own withTenant
 * for the standalone path. Defaults the A0c columns: grant_id null, audience null, owner_type 'user'.
 * The org RLS context must already be pinned on `tx` (withTenant).
 */
export async function insertApiKey(
  tx: TenantTx,
  input: CreateApiKeyInput,
  hasher: CredentialHasher,
): Promise<CreatedApiKey & { readonly keyHash: Buffer }> {
  // THE MINT CEILING. Every api key in the system — dashboard, OAuth, device-code — is born in this
  // function, which is why the check lives here rather than at each caller: a caller can be forgotten, a
  // chokepoint cannot. THROW rather than silently narrow: quietly handing back a weaker key than was asked
  // for teaches the user they hold a scope they don't, and they discover it at some later 403.
  const denied = exceedsMintCeiling(input.minterRole, input.scopes);
  if (denied.length > 0) throw new MintCeilingError(denied);

  const { plaintext, keyHash, start } = mintChecksummedCredential(API_KEY_PREFIX, hasher);
  const id = randomUUID();
  const scopes = [...input.scopes];
  const expiresAt = input.expiresAt ?? null;
  const grantId = input.grantId ?? null;
  const audience = input.audience ?? null;
  const ownerType = input.ownerType ?? "user";
  const createdBy = input.createdBy ?? null;

  await tx`
    insert into api_keys
      (id, org_id, key_hash, prefix, start, name, scopes, expires_at, grant_id, audience, owner_type,
       created_by)
    values
      (${id}, ${input.orgId}, ${keyHash}, ${API_KEY_PREFIX}, ${start}, ${input.name},
       ${tx.json(scopes)}, ${expiresAt}, ${grantId}, ${audience}, ${ownerType}, ${createdBy})`;

  return { id, orgId: input.orgId, name: input.name, scopes, start, expiresAt, plaintext, keyHash };
}

interface ApiKeyListRow {
  id: string;
  name: string;
  start: string;
  scopes: unknown;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function toApiKeyListItem(r: ApiKeyListRow): ApiKeyListItem {
  return {
    id: r.id,
    name: r.name,
    start: r.start,
    scopes: toScopes(r.scopes),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

/** List an org's api keys (newest first). Display metadata only — no hash, no plaintext. */
export async function listApiKeys(app: Sql, orgId: string): Promise<ApiKeyListItem[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<ApiKeyListRow[]>`
      select id, name, start, scopes, created_at, last_used_at, expires_at, revoked_at
      from api_keys
      where org_id = ${orgId}
      order by created_at desc`;
  });
  return rows.map(toApiKeyListItem);
}

/**
 * List an org's STANDALONE api keys (grant_id IS NULL), newest first — the keys NOT minted under a device
 * grant. The dashboard's "API keys" section shows these; grant-backed keys appear under their device (via
 * listApiKeysForGrant), so listing them here too would double-show them. Display metadata only.
 */
export async function listStandaloneApiKeys(app: Sql, orgId: string): Promise<ApiKeyListItem[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<ApiKeyListRow[]>`
      select id, name, start, scopes, created_at, last_used_at, expires_at, revoked_at
      from api_keys
      where org_id = ${orgId} and grant_id is null
      order by created_at desc`;
  });
  return rows.map(toApiKeyListItem);
}

/**
 * List the keys minted under MANY grants at once, grouped by grant id. Display metadata only.
 *
 * This exists because the per-grant `listApiKeysForGrant` below was an N+1 with teeth. The credentials page
 * called it once per grant inside a `Promise.all` — but every call opens its OWN `withTenant` transaction,
 * and the dashboard's client is `max: 1`, so the concurrency was a fiction: the calls queued on the single
 * connection and ran strictly serially. The page cost `(2 + N)` transactions x 4 round trips (BEGIN,
 * set_config, the query, COMMIT), growing with every device a user has ever authorised.
 *
 * This is ONE transaction and ONE query, whatever N is.
 *
 * The result is keyed by grant id and pre-seeded with an empty list for every id asked for, so a grant with
 * no keys is present-and-empty rather than missing — the caller never has to distinguish "no keys" from "I
 * forgot to ask".
 */
export async function listApiKeysForGrants(
  app: Sql,
  orgId: string,
  grantIds: readonly string[],
): Promise<Map<string, ApiKeyListItem[]>> {
  const byGrant = new Map<string, ApiKeyListItem[]>(grantIds.map((id) => [id, []]));
  // `= any('{}')` is valid SQL but a pointless round trip; an org with no grants is the common case.
  if (grantIds.length === 0) return byGrant;

  const rows = await withTenant(app, orgId, async (tx) => {
    // `in ${tx([...])}` — postgres.js expands a JS array into a real parameterized IN list. NOT
    // `= any(${ids}::uuid[])`: that cast makes the driver serialize the array as a bare comma-joined string
    // and Postgres rejects it ("malformed array literal"). A real-Postgres test caught that; a mocked one
    // would not have.
    return tx<(ApiKeyListRow & { grant_id: string })[]>`
      select id, grant_id, name, start, scopes, created_at, last_used_at, expires_at, revoked_at
      from api_keys
      where org_id = ${orgId} and grant_id in ${tx(grantIds as string[])}
      order by created_at desc`;
  });

  for (const row of rows) {
    // Rows arrive newest-first, and pushing in arrival order preserves that WITHIN each grant's bucket — so
    // each list matches what the per-grant query would have returned.
    //
    // CREATE the bucket on a miss; never silently drop the row.
    //
    // An earlier version did `byGrant.get(id)?.push(...)`, justified by a comment claiming an `= any(...)`
    // filter made a miss impossible. That justification was FALSE — the query matches with `in`, i.e. plain
    // string equality on the uuid TEXT. So any caller whose grant id differed from Postgres's rendering by so
    // much as a character of case would have had that device's keys land in no bucket at all, and the
    // credentials page would have shown a device with "no keys" while its keys were live. A silent wrong
    // answer, and a security-adjacent one: a key you cannot see is a key you cannot revoke.
    //
    // Keying the bucket off the DATABASE's own value removes the class of bug rather than the instance: the
    // grouping can no longer disagree with the rows it is grouping, whatever the caller passed in.
    const bucket = byGrant.get(row.grant_id);
    if (bucket) bucket.push(toApiKeyListItem(row));
    else byGrant.set(row.grant_id, [toApiKeyListItem(row)]);
  }
  return byGrant;
}

/** List the keys minted under one grant (newest first). Display metadata only — no hash, no plaintext. */
export async function listApiKeysForGrant(
  app: Sql,
  orgId: string,
  grantId: string,
): Promise<ApiKeyListItem[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<ApiKeyListRow[]>`
      select id, name, start, scopes, created_at, last_used_at, expires_at, revoked_at
      from api_keys
      where org_id = ${orgId} and grant_id = ${grantId}
      order by created_at desc`;
  });
  return rows.map(toApiKeyListItem);
}

/** The outcome of a row-level revoke: whether a row flipped, and its hash for cache invalidation. */
export interface RevokedKeyRow {
  /** True if a not-already-revoked row was stamped (RLS makes another org's key invisible -> false). */
  readonly revoked: boolean;
  /** The revoked key's hash, for the caller to evict from the credential cache. null if none revoked. */
  readonly keyHash: Buffer | null;
}

/**
 * Revoke an api key by id INSIDE the caller's tenant tx (stamps revoked_at), returning whether a row
 * flipped and its key_hash so the caller can invalidate the credential cache (this only touches the
 * row of record). RLS-scoped: another org's key is invisible -> { revoked: false, keyHash: null }.
 * Already-revoked is idempotent (revoked: false). The org RLS context must be pinned on `tx`. The
 * higher-level grants.revokeApiKey wraps this with the key_revoked audit; createApiKey/grants own
 * the tx so revoke + audit are atomic.
 */
export async function revokeApiKeyInTx(tx: TenantTx, id: string): Promise<RevokedKeyRow> {
  const rows = await tx<{ key_hash: Buffer }[]>`
    update api_keys
    set revoked_at = now(), updated_at = now()
    where id = ${id} and revoked_at is null
    returning key_hash`;
  const row = rows[0];
  return { revoked: row !== undefined, keyHash: row ? Buffer.from(row.key_hash) : null };
}

interface AuthnVerifyRow {
  id: string;
  org_id: string;
  scopes: unknown;
  expires_at: Date | null;
  revoked_at: Date | null;
  key_hash: Buffer;
  audience: string | null;
}

/**
 * The webhook_authn COLD lookup: resolve a key hash to its owning org + scopes, or
 * null. ORG-DISCOVERY-BY-HASH — there is no expected org before the lookup; the presented
 * key determines its org (that's why webhook_authn holds a FOR SELECT USING(true) policy
 * + a column-scoped grant). Honors revocation and expiry. Runs as webhook_authn through
 * the CACHE-DISABLED binding. Use this as the `coldLookup` of a credential resolver.
 *
 * Returns the key's stored per-key `api_keys.audience` (RFC 8707) when set — a per-key
 * OAuth-minted binding (A0a added the column) — else `undefined` for a legacy/org-wide key.
 * The resolver then conditionally stamps the presenting surface's audience for the undefined
 * case (A0b), keeping the shared cache audience-agnostic while confining per-key-audience keys
 * to their bound surface. verifyBearer rejects any audience mismatch.
 */
/** Default staleness window for the best-effort last_used_at stamp: don't re-write within 15 minutes. */
export const LAST_USED_THROTTLE_SECONDS = 900;

export interface ApiKeyColdLookupOptions {
  /**
   * Records a just-authenticated key's use. The surface injects {@link makeApiKeyLastUsedStamper}, whose task
   * opens its OWN connection and runs post-response — so it does NOT depend on the request's authn client,
   * which the handler's `finally` tears down before the deferred task runs. Omitted (unit tests, the ingest
   * resolver) → the column is simply not stamped. It is called ONLY for a valid key (past the revoke/expiry
   * guards) and CANNOT influence resolution: the call is wrapped so even a throwing sink is swallowed.
   */
  readonly stampLastUsed?: (keyId: string) => void;
}

export function makeApiKeyColdLookup(authn: Sql, opts: ApiKeyColdLookupOptions = {}) {
  return async function coldLookup(keyHash: Buffer): Promise<ResolvedPrincipal | null> {
    const rows = await authn<AuthnVerifyRow[]>`
      select id, org_id, scopes, expires_at, revoked_at, key_hash, audience
      from api_keys
      where key_hash = ${keyHash}`;
    const row = rows[0];
    if (!row) return null;
    // The lookup matched on equality, but never resolve a principal off an unverified
    // compare — re-check the stored hash against the queried hash in constant time
    // (defense-in-depth; this is exactly what credentialHashEquals exists for). Then guard
    // revocation and expiry explicitly so a stale/edge row can't resolve.
    if (!credentialHashEquals(Buffer.from(row.key_hash), keyHash)) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return null;

    // Record use — ONLY for a key that actually authenticated (past the revoke/expiry guards; a dead key's
    // use is not recorded). The stamper defers a self-contained write past the response, so nothing here is
    // awaited. The call is wrapped because a best-effort telemetry write must NEVER fail auth: even if the
    // injected sink throws synchronously (e.g. ctx.waitUntil refusing new deferred work), we swallow it and
    // still return the principal.
    if (opts.stampLastUsed) {
      try {
        opts.stampLastUsed(row.id);
      } catch {
        /* telemetry must never unwind authentication for a valid key */
      }
    }

    // Honor the key's intrinsic per-key audience if stored; undefined for a legacy/org-wide
    // key (the resolver stamps the presenting surface — conditional stamp, A0b). `|| undefined`
    // (not `?? undefined`) so an empty-string audience coalesces to "no binding" too — otherwise
    // a stored "" would survive the resolver's `audience !== undefined` guard and fail closed on
    // EVERY surface (assertAudience's strict `!==` rejects ""), silently bricking the key.
    return {
      orgId: row.org_id,
      scopes: toScopes(row.scopes),
      audience: row.audience || undefined,
      keyId: row.id,
    };
  };
}

export interface ApiKeyLastUsedStamperOptions {
  /** The webhook_authn connection string (the CACHE-DISABLED HYPERDRIVE_AUTHN binding). */
  readonly connectionString: string;
  /** The surface's `(p) => ctx.waitUntil(p)` — holds the isolate alive so the post-response task can run. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Staleness window; the stamp is skipped while `last_used_at` is newer than this. Default 15m. */
  readonly throttleSeconds?: number;
}

/**
 * Build the `last_used_at` stamper a surface injects into the cold lookup.
 *
 * Each stamp is a SELF-CONTAINED task deferred past the response via `waitUntil`: it opens its OWN
 * webhook_authn connection, issues the throttled UPDATE, then closes it — mirroring the ingest auto-delivery
 * pattern, precisely so it does NOT reuse the request's authn client (which the handler's `finally` closes
 * before this deferred task runs; reusing it would either add a primary-DB write to the response latency or
 * drop the write entirely). Best-effort: a failure is logged (keyId + error class only — never key material)
 * and swallowed. Nothing here can delay or fail authentication.
 */
export function makeApiKeyLastUsedStamper(
  opts: ApiKeyLastUsedStamperOptions,
): (keyId: string) => void {
  const throttleSeconds = opts.throttleSeconds ?? LAST_USED_THROTTLE_SECONDS;
  return (keyId: string) => {
    opts.waitUntil(stampLastUsedTask(opts.connectionString, keyId, throttleSeconds));
  };
}

/** The deferred, self-contained stamp task: open → throttled UPDATE → close, swallowing any fault. */
async function stampLastUsedTask(
  connectionString: string,
  keyId: string,
  throttleSeconds: number,
): Promise<void> {
  let authn: Sql | undefined;
  try {
    authn = createClient(connectionString, { max: 1 });
    // Throttled: only past the staleness window (or if never set), so a hot key is written at most once per
    // window rather than once per cold miss — the SQL condition also coalesces the cross-PoP writes.
    await authn`
      update api_keys set last_used_at = now()
      where id = ${keyId}
        and (last_used_at is null or last_used_at < now() - make_interval(secs => ${throttleSeconds}))`;
  } catch (err) {
    console.warn(
      JSON.stringify({
        message: "api_key.last_used_touch_failed",
        keyId,
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
  } finally {
    await authn?.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Resolve a presented `whk_` access key to its PARENT GRANT, cross-org by hash — for the issuer's RFC 7009
 * /revoke (Lane C A2b-4). Unlike the cold lookup this does NOT filter revoked/expired keys: /revoke must
 * find the grant even for a spent access token so it can still kill the (possibly-live) grant; revokeGrant
 * is idempotent. Runs as webhook_authn (the only role that reads api_keys cross-org by hash; `grant_id` was
 * granted to it in 0018). Loops pepper candidates so a key minted under a previous pepper still resolves.
 * Returns null for an unknown key OR a standalone key with no grant (grant_id null) — neither is
 * grant-revocable here.
 */
export async function findApiKeyGrant(
  authn: Sql,
  plaintext: string,
  hasher: CredentialHasher,
): Promise<{ orgId: string; grantId: string } | null> {
  // Unlike makeApiKeyColdLookup, no constant-time hash re-check: this is a revocation-resolution path,
  // not authentication — the caller already holds the token, the output is only the holder's own grantId
  // (no secret disclosed, no auth decision branched on a timing-leaky compare). The unique-index bytea
  // equality is exact.
  for (const candidate of hasher.candidates(plaintext)) {
    const [row] = await authn<{ org_id: string; grant_id: string | null }[]>`
      select org_id, grant_id from api_keys where key_hash = ${candidate}`;
    if (!row) continue;
    // key_hash is unique, so a matched row IS the key — no later pepper candidate can match a
    // different row; stop looping. A standalone key (grant_id null) isn't grant-revocable here -> null.
    return row.grant_id !== null ? { orgId: row.org_id, grantId: row.grant_id } : null;
  }
  return null;
}

/** Outcome of a by-plaintext revoke: whether the key existed, whether this call flipped it, and its hash. */
export interface RevokedByPlaintext {
  /** True if a key with this plaintext exists (any org), revoked or not. */
  readonly found: boolean;
  /** True only if THIS call stamped revoked_at (a re-report of an already-revoked key is false). */
  readonly revoked: boolean;
  readonly orgId: string | null;
  readonly keyId: string | null;
  /** The stored key_hash, so the caller can evict the credential cache. null when not found. */
  readonly keyHash: Buffer | null;
  /** The key's name, so the owner can be told WHICH key was killed. null when not found. */
  readonly keyName: string | null;
  /** The non-secret `whk_…` display handle (never the full key). null when not found. */
  readonly keyStart: string | null;
}

/**
 * Revoke an api key given ONLY its raw plaintext — the secret-scanning auto-revoke path (ADR-0074),
 * where GitHub hands us a leaked token with no orgId/keyId. Two steps:
 *   1. CROSS-ORG discovery-by-hash as `webhook_authn` (loops pepper candidates so a key minted under a
 *      previous pepper still resolves), modeled on findApiKeyGrant but returning the KEY id + hash and
 *      NOT filtering revoked — so a re-report (GitHub's payload has no nonce → replayable) is idempotent.
 *   2. Audited revoke as `webhook_app`, tenant-scoped: withTenant + revokeApiKeyInTx + an `aae1`
 *      key_revoked audit row (actor null = system; metadata records the source) when a row flips.
 * Returns the org/key/hash so the caller evicts the KV credential cache by `credentialCacheKey(keyHash)`.
 * Not an authentication path: the caller already holds the token; no constant-time compare needed.
 */
export async function revokeApiKeyByPlaintext(
  authn: Sql,
  app: Sql,
  plaintext: string,
  hasher: CredentialHasher,
  auditKey: CryptoKey,
): Promise<RevokedByPlaintext> {
  // Discovery uses ONLY webhook_authn's column-scoped grant (org_id + key_hash — same columns the
  // cold lookup reads). It deliberately does NOT select `id` even though 0059 now grants it: this query
  // only needs to find the row, and the keyId is resolved later under webhook_app alongside the columns
  // (like created_by) that authn must never see.
  let match: { orgId: string; keyHash: Buffer } | null = null;
  for (const candidate of hasher.candidates(plaintext)) {
    const [row] = await authn<{ org_id: string; key_hash: Buffer }[]>`
      select org_id, key_hash from api_keys where key_hash = ${candidate}`;
    if (row) {
      // key_hash is unique, so a matched row IS the key — stop looping (no later candidate matches another).
      match = { orgId: row.org_id, keyHash: Buffer.from(row.key_hash) };
      break;
    }
  }
  if (match === null)
    return {
      found: false,
      revoked: false,
      orgId: null,
      keyId: null,
      keyHash: null,
      keyName: null,
      keyStart: null,
    };

  const { orgId, keyHash } = match;
  // As webhook_app under the org's RLS context: resolve the key id (app has full SELECT on its org's
  // rows, unlike authn), then revoke + audit via the shared tx-level primitive. `name`/`start` come back
  // too so the caller can tell the owner WHICH key died — both are non-secret (start is the same handle
  // the dashboard lists).
  const { revoked, keyId, keyName, keyStart } = await withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ id: string; name: string; start: string }[]>`
      select id, name, start from api_keys where key_hash = ${keyHash}`;
    if (!row)
      return {
        revoked: false,
        keyId: null as string | null,
        keyName: null as string | null,
        keyStart: null as string | null,
      };
    const result = await revokeApiKeyInTx(tx, row.id);
    if (result.revoked) {
      await appendAuthAuditEntry(tx, auditKey, {
        orgId,
        actor: null,
        eventType: "key_revoked",
        targetId: row.id,
        metadata: { source: "github_secret_scanning" },
      });
    }
    return { revoked: result.revoked, keyId: row.id, keyName: row.name, keyStart: row.start };
  });
  return { found: true, revoked, orgId, keyId, keyHash, keyName, keyStart };
}

/** Input to {@link enqueueApiKeyRevokedNotification}. Non-secret identifiers only. */
export interface ApiKeyRevokedNotification {
  readonly orgId: string;
  readonly keyName: string | null;
  readonly keyStart: string | null;
  readonly source: "github_secret_scanning";
}

/**
 * Queue the "we revoked your leaked key" owner email (ADR-0074). A destination-less `api_key_revoked`
 * intent — the same shape `usage_threshold` uses — drained hourly by the auth worker's notifier cron,
 * which owns the identity-email read and the Resend binding. No migration: `kind` is free text and
 * `destination_id` is nullable by design.
 *
 * DELIBERATELY A SEPARATE TX from the revoke, and called only AFTER it commits. The engine's
 * auto-disable writes its intent in the same tx as the disable, because there both halves are the
 * action. Here they are not: revoking a leaked key is the safety-critical step and a courtesy email is
 * not. If the intent insert shared the revoke's tx, an insert failure would ROLL BACK the revoke and
 * leave a leaked key live — trading a real compromise for a missed email. So the caller commits the
 * revoke, then enqueues best-effort (see `revokeAndNotify` in apps/api).
 */
export async function enqueueApiKeyRevokedNotification(
  app: Sql,
  input: ApiKeyRevokedNotification,
): Promise<string> {
  return withTenant(app, input.orgId, (tx) =>
    insertNotificationIntent(tx, {
      orgId: input.orgId,
      kind: "api_key_revoked",
      destinationId: null,
      context: {
        keyName: input.keyName ?? "",
        keyStart: input.keyStart ?? "",
        source: input.source,
      },
    }),
  );
}

/** Coerce the jsonb `scopes` column (postgres.js returns it parsed) to a string[]. */
function toScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}
