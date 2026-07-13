# ADR-0115: A membership change is an **atomic revocation**

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-0073 (api-key model), the S.5 mint ceiling, ADR-0113 (the org directory)

## Context

Removing a member, or demoting one, must not merely change a row. Scopes are **frozen into a key at mint
time** (the mint ceiling narrows *at mint*, and nothing narrows retroactively), so a key minted under an
authority the user no longer holds keeps working. Changing `memberships.role` while leaving those credentials
alive is a rename, not a revocation.

## Decision

**The membership change and the death of the credentials it authorized happen in ONE transaction.**

| | effect |
|---|---|
| **Remove** | delete the membership · revoke their grants · revoke the keys minted under those grants · revoke **every key they created**, including org-owned service keys |
| **Demote** | revoke the same set (those keys may carry scopes above the new role) |
| **Promote** | revoke nothing — a *wider* authority invalidates no existing credential |

Org-owned service keys the leaver created are revoked too: **they may still hold the plaintext.** Leaving
them live would let an ex-member keep org access through a key they minted.

The caller must then **evict the returned key hashes** from the shared KV credential cache. The DB revoke is
what makes it durable; the eviction closes the cache-TTL window. **Ordering is load-bearing:** DB commit
*first*, then evict. A throw evicts nothing.

**Leaving is removing yourself**, so it calls the same code path rather than a parallel one that could drift.

### Locking: the revoke must contend with the refresh

`mintKeyForGrant` does `select … from auth_grant … FOR UPDATE` and refuses on a non-active grant. **That row
lock is the protocol.** A revoker must contend on the grant row, or a refresh already holding the lock commits
a **brand-new key** after the `api_keys` sweep has taken its snapshot — and the cold auth lookup
authenticates on `revoked_at is null` **alone** (it checks neither grant status nor membership), so that key
would keep working forever for a member we just removed.

- **Removal:** revoke the **grants first** (taking the locks), *then* sweep the keys.
- **Demotion:** the grant legitimately stays active (its next refresh re-mints, narrowed), so nothing else in
  the transaction contends with the minter — it must take `FOR UPDATE` on the user's grants **explicitly**.

### Authorization lives in the DB layer

You cannot act on someone who outranks you; you cannot grant a role above your own; and the **last owner can
never be demoted or removed**. Typed refusals (`MemberCeilingError` / `LastOwnerError` /
`MemberNotFoundError`) so callers map them rather than guess.

> ⚠️ The last-owner guard is a **TOCTOU** unless the decision and the write are one atomic unit. The census
> counts owners, but each mutation touches only the *target's* row — so two transactions removing two
> *different* owners never contend, both read `owners = 2`, both pass, and both commit, leaving a
> **zero-owner org**. A per-org advisory lock is taken **before** the census. (The audit chain's own advisory
> lock does *not* save you: it is taken *after* the decision.)

## Consequences

- A zero-owner org is the failure this exists to prevent: **RLS-unreachable forever**, still billed by Stripe,
  and its failure alerts go nowhere — and no admin can repair it, because `canGrantRole('admin','owner')` is
  false. The same guard therefore blocks account deletion and "leave org", **across every org the user solely
  owns** — which only became computable once ADR-0113 made "which orgs do I own?" answerable.
- **Unattributable keys are surfaced, not silently claimed away.** A standalone key with a null `created_by`
  cannot be tied to the leaver — and this is **not** merely a legacy set: `created_by` is
  `ON DELETE SET NULL`, so deleting a creator's account destroys attribution *by design*. It can never be
  fixed by a backfill. Removal counts them, audits the count, and reports it. **Never claim an atomicity you
  don't have.**
- Every mutation writes a tamper-evident `auth_audit_event` row **in the same transaction**, so the trail can
  never disagree with the state.
