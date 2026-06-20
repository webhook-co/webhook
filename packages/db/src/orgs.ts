// Org creation (the tenant root). createOrg mints the org id at the edge and inserts the
// row under the NEW org's own RLS context -- the orgs insert policy gates on
// `id = current_org_id()`, so app.current_org must be set to the new id for the insert to
// pass. withTenant sets it. Runs as webhook_app.

import { createHash, randomUUID } from "node:crypto";

import { withTenant, type Sql } from "./client";
import { mintCredential, type CredentialHasher } from "./credential";
import { INGEST_TOKEN_PREFIX } from "./endpoints";

export interface CreateOrgInput {
  /** URL-safe unique handle (citext unique in the schema). */
  readonly slug: string;
  readonly name: string;
  /** Residency-routing anchor; defaults to the orgs table default ('us'). */
  readonly region?: string;
}

export interface CreatedOrg {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly region: string;
}

/**
 * Create a tenant org. The id is edge-generated (randomUUID() is the stand-in until the
 * shared uuidv7 mint is adopted on the control-plane tables, like createApiKey; orgs are
 * low-volume so v4-vs-v7 index locality is immaterial here). The row is inserted under the
 * new org's RLS context (the orgs insert policy gates on id = current_org_id()).
 */
export async function createOrg(app: Sql, input: CreateOrgInput): Promise<CreatedOrg> {
  const id = randomUUID();
  const region = input.region ?? "us";
  await withTenant(app, id, async (tx) => {
    await tx`
      insert into orgs (id, slug, name, region)
      values (${id}, ${input.slug}, ${input.name}, ${region})`;
  });
  return { id, slug: input.slug, name: input.name, region };
}

export type MembershipRole = "owner" | "admin" | "member";

/**
 * Add a user to an org with a role, under the org's RLS context. RLS (memberships WITH CHECK
 * org_id = current_org_id(), pinned by withTenant) only guarantees the row lands in the CONTEXT org —
 * it does NOT decide WHETHER the caller may add members. Membership = access control, so the CALLER
 * (Lane C) MUST verify the authenticated principal administers `orgId` before calling; this primitive
 * trusts its `orgId`. The `userId` must reference an existing better-auth `"user"` row (FK).
 */
export async function createMembership(
  app: Sql,
  input: { orgId: string; userId: string; role: MembershipRole },
): Promise<void> {
  await withTenant(app, input.orgId, async (tx) => {
    await tx`
      insert into memberships (org_id, user_id, role)
      values (${input.orgId}, ${input.userId}, ${input.role})`;
  });
}

/**
 * The tenancy bind for the OAuth issuer: is `userId` a member of `orgId`? The `/token` mint asserts this
 * before minting a key for a consent-recorded org (token-core's `isOrgMember` seam), so a tampered or
 * stale `props.orgId` can never mint into an org the user doesn't belong to. RLS pins the lookup to the
 * context org, so this only ever sees the one org's memberships.
 */
export async function isOrgMember(app: Sql, userId: string, orgId: string): Promise<boolean> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ one: number }[]>`
        select 1 as one from memberships where org_id = ${orgId} and user_id = ${userId} limit 1`,
  );
  return rows.length > 0;
}

/** Distinguishes the bootstrap advisory-lock space from any other advisory-lock user. */
const BOOTSTRAP_LOCK_NAMESPACE = 0x42535450; // "BSTP"

/**
 * A STABLE per-user uuid (SHA-256 of a domain-separated seed, formatted as a v8 UUID). Used as the
 * personal org / default endpoint id so bootstrap is idempotent WITHOUT a cross-org lookup — RLS
 * (org_id = current_org_id()) makes a "does this user already have an org?" query impossible for
 * webhook_app, so we make the ids deterministic and rely on ON CONFLICT instead. Deterministic ids
 * are not secret: org access is gated by RLS + membership, never by id unguessability.
 */
function deterministicUuid(seed: string): string {
  const b = createHash("sha256").update(seed).digest(); // 32 bytes — indices 6/8 always present
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8 (custom)
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface BootstrapPersonalOrgInput {
  readonly userId: string;
  /** URL-safe unique org handle (citext unique). Must be unique across orgs on first create. */
  readonly slug: string;
  readonly name: string;
  readonly region?: string;
  /** Display name for the default endpoint. Defaults to "default". */
  readonly endpointName?: string;
}

export interface BootstrapPersonalOrgResult {
  readonly orgId: string;
  readonly endpointId: string;
  /** True if this call created the ORG (false = idempotent re-run for an already-bootstrapped user). */
  readonly created: boolean;
  /**
   * The default endpoint's ingest token plaintext — surfaced ONCE, only when this call actually minted
   * the endpoint (first bootstrap, or a self-heal re-mint after the endpoint was deleted). Undefined on
   * a plain idempotent re-run.
   */
  readonly ingestToken?: string;
}

/**
 * The atomic signup primitive (Lane C A1 calls it once): create a user's personal org + their owner
 * membership + a default endpoint in ONE transaction. Idempotent — a re-run for the same user returns
 * the existing org (created: false) with no duplicate rows and no re-revealed token. Idempotency uses a
 * STABLE per-user org/endpoint id (deterministicUuid) + ON CONFLICT DO NOTHING, because RLS forbids
 * webhook_app from looking a user's org up cross-org; a per-user transaction-scoped advisory lock
 * serializes concurrent bootstraps. Atomicity (one tx) means a partial failure rolls back fully.
 *
 * Preconditions / caller (Lane C) contract:
 *  - `userId` MUST be the server-authenticated user (never client-supplied): the org id derives from it
 *    and this call grants `userId` ownership. The better-auth `"user"` row must already exist (FK).
 *  - `slug` must be globally unique. The conflict key is the org ID, NOT the slug — so a slug already
 *    taken by ANOTHER user's org raises a unique violation and throws (the caller owns slug-uniqueness
 *    UX/retry). On an idempotent re-run, a changed slug/name/region is IGNORED (this is not an upsert).
 */
export async function bootstrapPersonalOrg(
  app: Sql,
  input: BootstrapPersonalOrgInput,
  hasher: CredentialHasher,
): Promise<BootstrapPersonalOrgResult> {
  const orgId = deterministicUuid(`webhook:personal-org:${input.userId}`);
  const endpointId = deterministicUuid(`webhook:personal-endpoint:${input.userId}`);
  const region = input.region ?? "us";

  return withTenant(app, orgId, async (tx) => {
    // Serialize concurrent bootstraps for this user (the xact lock auto-releases on commit).
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.userId}, ${BOOTSTRAP_LOCK_NAMESPACE}))`;

    const orgRows = await tx<{ id: string }[]>`
      insert into orgs (id, slug, name, region)
      values (${orgId}, ${input.slug}, ${input.name}, ${region})
      on conflict (id) do nothing
      returning id`;
    const created = orgRows.length > 0;

    await tx`
      insert into memberships (org_id, user_id, role)
      values (${orgId}, ${input.userId}, ${"owner"})
      on conflict (org_id, user_id) do nothing`;

    // The default endpoint is idempotent on its OWN deterministic id, independently of `created`: if
    // the endpoint were ever deleted while the org survived, a re-run re-mints it (self-heal) rather
    // than leaving the org with no ingest URL. The signed ingest token is revealed ONLY when this call
    // actually inserted the row (RETURNING non-empty); mintCredential is cheap (CSPRNG + HMAC, no IO),
    // so computing it before the ON CONFLICT and discarding it on a conflict is fine.
    const { plaintext, keyHash } = mintCredential(INGEST_TOKEN_PREFIX, hasher);
    const epRows = await tx<{ id: string }[]>`
      insert into endpoints (id, org_id, ingest_token_hash, name)
      values (${endpointId}, ${orgId}, ${keyHash}, ${input.endpointName ?? "default"})
      on conflict (id) do nothing
      returning id`;
    const ingestToken = epRows.length > 0 ? plaintext : undefined;

    return { orgId, endpointId, created, ingestToken };
  });
}
