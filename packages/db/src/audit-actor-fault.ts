import { CapabilityFault } from "@webhook-co/contract";
import {
  auditActorFromContext,
  type AuditActorContext,
  type AuditActorInput,
} from "@webhook-co/shared";

/**
 * The actor for an audited mutation, or a typed refusal.
 *
 * An audited mutation whose principal we cannot identify must FAIL rather than quietly write `actor = NULL`
 * — the null actor is precisely the defect this vocabulary exists to remove, and a compliance chain that
 * silently records "someone did this" is worse than one that refuses.
 *
 * It refuses as a `CapabilityFault`, not a bare `Error`, and that distinction is the whole reason this lives
 * in db rather than in shared (a leaf package, which cannot import the contract): every capability handler
 * runs inside a fault boundary that maps the closed error taxonomy to each surface's transport. A bare throw
 * would escape that boundary as an opaque 500 with a stack-shaped log line and no code for the caller;
 * `UNAUTHORIZED` says the true thing — we could not establish who is acting — and maps to a clean 401.
 *
 * This is unreachable by construction on every live path (`verifyBearer` always resolves a keyId for a bearer
 * key; a web action always has a session user; the MCP opaque-token path always carries the grant's userId),
 * and a principal cached before `keyId` existed is rejected as a stale shape by the resolver's `requireKeyId`
 * rather than served. But `AuthContext.keyId` and `.userId` are both optional, so nothing in the type system
 * stops a FUTURE caller (a service binding, an internal RPC) from constructing a principal with neither — and
 * when that happens it must get a clean refusal, not a 500.
 */
export function requireAuditActor(ctx: AuditActorContext): AuditActorInput {
  const actor = auditActorFromContext(ctx);
  if (actor.kind === "unattributed") {
    throw new CapabilityFault(
      "UNAUTHORIZED",
      "the request principal identifies neither a key nor a user, so the action cannot be audited",
    );
  }
  return actor;
}
