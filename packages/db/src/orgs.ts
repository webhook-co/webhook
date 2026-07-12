// Org creation (the tenant root). createOrg mints the org id at the edge and inserts the
// row under the NEW org's own RLS context -- the orgs insert policy gates on
// `id = current_org_id()`, so app.current_org must be set to the new id for the insert to
// pass. withTenant sets it. Runs as webhook_app.

import { createHash, randomUUID } from "node:crypto";

import { FREE_RETENTION_DAYS } from "@webhook-co/shared";

import { withTenant, type Sql, type TenantTx, withUser } from "./client";
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
    // Explicit Free window — the column default is NULL = unlimited (0056, the fail-safe against pruning an
    // unmirrored paid org), so a new free org must set its 7-day window here rather than inherit unlimited.
    await tx`
      insert into orgs (id, slug, name, region, retention_days)
      values (${id}, ${input.slug}, ${input.name}, ${region}, ${FREE_RETENTION_DAYS})`;
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

export interface CreateOrgWithOwnerInput extends CreateOrgInput {
  /** The user who becomes the org's first OWNER — inserted in the SAME transaction as the org. */
  readonly ownerUserId: string;
}

/**
 * Create a tenant org AND its first owner membership ATOMICALLY (one transaction). This is the primitive any
 * "create a shared org" flow (team creation, invite-accept that spins up an org) MUST use — NOT createOrg
 * followed by createMembership, which are separate transactions: a crash between them would leave an org with
 * NO members, a zero-owner orphan that RLS makes permanently unreachable (the same trap the last-owner guard
 * prevents on the delete side). Here the org and its owner commit together or not at all — a bad ownerUserId
 * (the "user" FK) rolls the whole thing back, so an orphan can never be born. The caller still owns authz
 * (who may create an org); this primitive trusts its input.
 */
export async function createOrgWithOwner(
  app: Sql,
  input: CreateOrgWithOwnerInput,
): Promise<CreatedOrg> {
  const id = randomUUID();
  const region = input.region ?? "us";
  await withTenant(app, id, async (tx) => {
    await tx`
      insert into orgs (id, slug, name, region, retention_days)
      values (${id}, ${input.slug}, ${input.name}, ${region}, ${FREE_RETENTION_DAYS})`;
    await tx`
      insert into memberships (org_id, user_id, role)
      values (${id}, ${input.ownerUserId}, ${"owner"})`;
  });
  return { id, slug: input.slug, name: input.name, region };
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

/**
 * `userId`'s role IN `orgId` — the ONE org-scoped membership-role read. Null when they aren't a member.
 *
 * Takes an open tenant transaction because every caller already has one (the role is read alongside the
 * org's own billing/limits state, under a single RLS context).
 *
 * The `org_id` predicate is stated EXPLICITLY and must stay that way. RLS scopes `memberships` with
 * `org_id = current_org_id()` today, which withTenant pins — but Postgres policies are PERMISSIVE and OR
 * together, so the day a second SELECT policy exists (e.g. `user_id = current_app_user()`, which listing
 * "the orgs I belong to" for an org switcher requires), a query that leaned on RLS alone would silently go
 * CROSS-ORG. With `limit 1` and no `ORDER BY` it would then return an ARBITRARY row: a user who is a plain
 * `member` of the team but `owner` of their own personal org could read back `owner` and pass an
 * owner/admin gate on the TEAM. That is a real-money escalation opened by a policy that looks purely
 * additive — so the isolation lives here, in the query, not in an assumption about the policy set.
 */
export async function readMembershipRole(
  tx: TenantTx,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const rows = await tx<{ role: string }[]>`
    select role from memberships where org_id = ${orgId} and user_id = ${userId} limit 1`;
  return rows[0]?.role ?? null;
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

/**
 * The STABLE id of a user's personal org — the same deterministic id `bootstrapPersonalOrg` mints. Pure
 * (no DB read): RLS forbids webhook_app from looking a user's org up cross-org, so the issuer resolves it
 * by re-deriving the id rather than querying. Not secret (org access is gated by RLS + membership, never id
 * unguessability). Lane C's `/authorize` uses it to find the org a consent grant is for.
 */
export function personalOrgId(userId: string): string {
  return deterministicUuid(`webhook:personal-org:${userId}`);
}

export interface UserOrg {
  readonly orgId: string;
  readonly name: string;
  /** The caller's role in that org. */
  readonly role: MembershipRole;
}

/**
 * Every org the user belongs to — the read multi-org needs, and the one the ORG-scoped RLS policies
 * structurally cannot answer (they can only confirm an org you already name, which is exactly why
 * `personalOrgId` DERIVES an id instead of querying for one).
 *
 * Reads through `user_org_directory()` (migration 0067), the ONE place the cross-org question may be asked.
 * webhook_app has NO user-scoped policy of its own — deliberately, so that an unqualified membership read by
 * the request-path role still cannot see another org, and the permissive-policy escalation this lane could
 * so easily have introduced simply does not exist. The capability is confined to the definer function, which
 * takes no argument and is bounded by `user_id = current_app_user()`.
 *
 * {@link withUser} sets that GUC (and NO tenant GUC — the caller is *choosing* an org, so it cannot already
 * have one). `userId` MUST come from the verified session: it is the entire authorization boundary here.
 * Ordered oldest-first (tie-broken by org id), so the personal org leads and the order is stable.
 */
export async function listUserOrgs(app: Sql, userId: string): Promise<UserOrg[]> {
  const rows = await withUser(
    app,
    userId,
    (tx) =>
      tx<{ org_id: string; name: string; role: MembershipRole }[]>`
        select org_id, name, role from user_org_directory()`,
  );
  return rows.map((r) => ({ orgId: r.org_id, name: r.name, role: r.role }));
}

/**
 * The orgs an interactive consent grant may be for (Lane 2.4) — the user's own memberships, personal org
 * first. Replaces the old `getConsentOrg`, which DERIVED the personal org and so could only ever hand back
 * one: that is why an invited teammate's CLI/MCP landed in their own empty org instead of the org they were
 * invited to.
 *
 * The FIRST entry is the default selection; the whole list is sealed into the consent ticket as the
 * allowlist the decision endpoint validates the user's pick against. Empty ⇒ the user has no org at all
 * (bootstrap should have made one), which the issuer treats as a server error rather than guessing.
 */
export async function listConsentOrgs(
  app: Sql,
  userId: string,
): Promise<{ orgId: string; name: string }[]> {
  const orgs = await listUserOrgs(app, userId);
  return orgs.map((o) => ({ orgId: o.orgId, name: o.name }));
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
  const orgId = personalOrgId(input.userId);
  const endpointId = deterministicUuid(`webhook:personal-endpoint:${input.userId}`);
  const region = input.region ?? "us";

  return withTenant(app, orgId, async (tx) => {
    // Serialize concurrent bootstraps for this user (the xact lock auto-releases on commit).
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.userId}, ${BOOTSTRAP_LOCK_NAMESPACE}))`;

    // retention_days is set EXPLICITLY to the Free window, not left to the column default. The default is
    // now NULL = unlimited (0056, the fail-safe backstop against pruning an unmirrored paid org), so a free
    // org that relied on the default would silently retain forever. This is the one real free-org creation
    // path, so it owns the Free window.
    const orgRows = await tx<{ id: string }[]>`
      insert into orgs (id, slug, name, region, retention_days)
      values (${orgId}, ${input.slug}, ${input.name}, ${region}, ${FREE_RETENTION_DAYS})
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
