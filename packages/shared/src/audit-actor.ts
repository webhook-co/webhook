// WHO performed an audited action — a closed, typed vocabulary for the `audit_log.actor` column.
//
// THE DEFECT THIS FIXES: `actor` was a bare `string | null`, and every write handler on api/mcp/cli passed
// `ctx.userId ?? null`. A standalone api key carries NO userId (the resolved bearer principal is
// {orgId, scopes} — it never even reads the key's id), so EVERY mutation made over the API, MCP, or the CLI
// was recorded with `actor = NULL` — byte-identical to the delivery DO's genuine system actions. The
// compliance chain could not answer "who did this", and an incident could not answer the only question that
// matters next: WHICH CREDENTIAL DO I ROTATE.
//
// WHY IT LIVES IN THE `actor` COLUMN, and not a new one: `actor` is one of the five fields inside the frozen
// `wha1` hash canon (see audit.ts). Attribution that sits OUTSIDE the hash is not tamper-evident, which for
// a compliance record is worse than useless. A prefixed string is still a string, so the canon, the chain,
// and every previously-written row verify unchanged — no migration, no canon bump.
//
// THE RULE: the actor is the CREDENTIAL THAT AUTHENTICATED THE REQUEST.
//   * web session          -> `user:<userId>`  (the human is the credential)
//   * api / mcp / cli key  -> `key:<keyId>`    (the key is the credential — and the rotatable one)
//   * delivery DO / cron   -> `system`
//
// We deliberately do NOT denormalize the accountable human onto a key's audit row. `api_keys.created_by`
// (migration 0057) already records it, and resolving it by join at READ time keeps that link authoritative
// (it cannot drift from the key row) and keeps the bearer HOT PATH narrow — `webhook_authn`, the most
// exposed DB role in the system, is granted a deliberately minimal column list and must never learn who
// created a key. Copying the human onto every audit row would buy nothing and widen that grant.

/** A parsed `audit_log.actor`. `unattributed` and `legacy` describe rows written BEFORE this vocabulary. */
export type AuditActor =
  | { readonly kind: "user"; readonly id: string; readonly legacy?: true }
  | { readonly kind: "key"; readonly id: string }
  | { readonly kind: "system" }
  /** A pre-existing row whose actor is NULL. We cannot know whether it was a key or the system. */
  | { readonly kind: "unattributed" };

const USER_PREFIX = "user:";
const KEY_PREFIX = "key:";
const SYSTEM = "system";

/**
 * The actors a NEW row may be written with. `unattributed` is excluded by construction: it exists solely to
 * READ rows written before this vocabulary, and a row we write today must always name its actor.
 */
export type AuditActorInput = Exclude<AuditActor, { kind: "unattributed" }>;

/** The exact string stored in `audit_log.actor` (and therefore hashed into the chain). */
export function formatAuditActor(actor: AuditActorInput): string {
  switch (actor.kind) {
    case "user":
      return `${USER_PREFIX}${actor.id}`;
    case "key":
      return `${KEY_PREFIX}${actor.id}`;
    case "system":
      return SYSTEM;
  }
}

/**
 * Read a stored `actor` back into the typed vocabulary.
 *
 * Ids are opaque, so the prefix is stripped by LENGTH rather than by splitting on every colon — an id that
 * itself contains a colon must round-trip intact, not be truncated into a different (and therefore wrong)
 * id. Anything without a known prefix is a legacy row: a bare user id (what the web actions used to write).
 * NULL is `unattributed` — NOT `system`, because we genuinely do not know which it was, and a compliance
 * log must not invent an attribution it never captured.
 */
export function parseAuditActor(raw: string | null): AuditActor {
  if (raw === null) return { kind: "unattributed" };
  if (raw === SYSTEM) return { kind: "system" };
  if (raw.startsWith(KEY_PREFIX)) return { kind: "key", id: raw.slice(KEY_PREFIX.length) };
  if (raw.startsWith(USER_PREFIX)) return { kind: "user", id: raw.slice(USER_PREFIX.length) };
  return { kind: "user", id: raw, legacy: true };
}

/** A short human label for an actor. Ids are pseudonymous, so the caller resolves display names. */
export function describeAuditActor(actor: AuditActor): string {
  switch (actor.kind) {
    case "user":
      return "User";
    case "key":
      return "API key";
    case "system":
      return "System";
    case "unattributed":
      return "Unattributed";
  }
}

/** The actor for a web-session mutation: the human IS the credential (no api key is involved). */
export function userActor(userId: string): AuditActorInput {
  return { kind: "user", id: userId };
}

/** The actor for an action with no principal at all — the delivery DO, a cron, the reconciler. */
export const SYSTEM_ACTOR: AuditActorInput = { kind: "system" };

/** The subset of an AuthContext that identifies the presenting principal. */
export interface AuditActorContext {
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly userId?: string;
  readonly keyId?: string;
}

/**
 * The actor for a request-bound mutation.
 *
 * The KEY WINS over the user when both are present (a grant-minted key used over MCP carries the granting
 * human's userId as well as its own id): the key is what actually authenticated the call and what an
 * incident responder must revoke, and the human remains one join away via `api_keys.created_by`.
 *
 * Falls back to `unattributed` — never to `system`. Stamping `system` on a request that HAD a principal we
 * merely failed to identify would be a lie told by the compliance log, and precisely the ambiguity this
 * module exists to remove.
 */
export function auditActorFromContext(ctx: AuditActorContext): AuditActor {
  if (ctx.keyId !== undefined) return { kind: "key", id: ctx.keyId };
  if (ctx.userId !== undefined) return { kind: "user", id: ctx.userId };
  return { kind: "unattributed" };
}

/**
 * The actor for an audited mutation, or a throw.
 *
 * An audited mutation whose principal we cannot identify must FAIL, not quietly write `actor = NULL` — the
 * null actor is precisely the defect this module exists to remove, and a compliance chain that silently
 * records "someone did this" is worse than one that refuses. This is unreachable by construction on every
 * live path (verifyBearer always resolves a keyId for a bearer key; a web action always has a session user),
 * and both of the ways a principal could have arrived without one — a KV principal cached before keyId
 * existed, and an MCP session whose DO props predate it — are foreclosed by a cache-namespace bump and a
 * session-envelope version bump respectively.
 */
export function requireAuditActor(ctx: AuditActorContext): AuditActorInput {
  const actor = auditActorFromContext(ctx);
  if (actor.kind === "unattributed") {
    throw new Error("audit: the request principal identifies neither a key nor a user");
  }
  return actor;
}
