# ADR-0113: Multi-org identity — the org directory, the session's org, and switching

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-0019/0020 (governance schema), ADR-0034 (app session handoff), ADR-0023 (the DAL gate)
- **Supersedes in part:** the "identity-only session" sketch in the collaboration plan (see _Divergence_)

## Context

Until this epic a user had exactly one org — the **personal org**, whose id is *derived* from the user id
(`personalOrgId(userId)`, a deterministic UUID). Nothing queried "which orgs does this user belong to?",
because nothing could: every RLS policy on `memberships` is `org_id = current_org_id()`, i.e. **you may only
ask about an org you already name**. That is precisely *why* the id is derived rather than looked up.

Invites broke that assumption: a user can now hold memberships in several orgs. Three questions followed.

1. **How does the system enumerate a user's orgs at all?** (Nothing could.)
2. **Where does the "acting org" live** for a web session?
3. **How does a user change it** without that becoming a way to act on an org they don't belong to?

## Decision

### 1. The cross-org read is confined to one SECURITY DEFINER function

`user_org_directory()` (migration 0067) returns the caller's own memberships and the orgs they point at. It
takes **no argument** and reads a `current_app_user()` GUC, so it cannot be pointed at another user; an unset
GUC yields nothing (deny-by-default). `withUser(app, userId, fn)` sets that GUC, mirroring `withTenant`.

**`webhook_app` gets no new RLS policy.** Its view of `memberships` is exactly what it was.

#### The alternative we rejected, and why it matters

The obvious design is a permissive policy on the request-path role:

```sql
create policy memberships_self_select on memberships
  for select using (user_id = current_app_user());   -- DO NOT DO THIS
```

It works — and it quietly arms a privilege escalation, because **Postgres policies are permissive and OR
together**. From that moment, *any* membership read that does not name `org_id` is silently **cross-org**.
That is not hypothetical: Lane S.4 fixed three queries shaped exactly like

```sql
select role from memberships where user_id = $1 limit 1   -- no org_id, no ORDER BY
```

Under such a policy that returns an **arbitrary row**, so a plain `member` of a team who *owns* their personal
org reads back `owner` and clears an owner/admin gate **on the team**.

We first tried to hold that line with a lint rule. A high-effort review then reproduced **four independent
bypasses** of it (an `org_id =` anywhere in the statement — even inside a CTE; a stray backtick desyncing the
scanner; string-built SQL; a loose opt-out marker). The conclusion is the durable part:

> **A static text scanner over SQL cannot be a security boundary, and a leaky lock on a live escalation is
> worse than no lock, because it manufactures confidence.**

So the hazard is **removed**, not guarded. With no permissive policy on `webhook_app`, there is nothing to
escalate through, and the lint rule was deleted.

The two policies that *do* enable the directory are scoped **`to webhook_owner`**, so only the definer can
evaluate them. This is sound because `memberships` is `FORCE ROW LEVEL SECURITY`: the definer is **policed**,
not bypassing RLS.

> ⚠️ A policy's expression is evaluated **as the calling role**. An unscoped `orgs` policy whose `USING` reads
> `memberships` would require *every* role that merely touches `orgs` (billing, meter, sweeper, reconciler,
> notifier) to hold a `memberships` grant — the first attempt broke the billing writer with
> `permission denied for table memberships`. Always scope such a policy `TO <role>`.

### 2. The session keeps its `orgId`; switching **re-mints** the cookie

The acting org stays in the signed session cookie. `switchOrgAction` treats the target org as **untrusted
input**: it re-reads the user's memberships server-side and refuses anything else, minting nothing.
`requireOrgAccess` (ADR-0023) then re-checks membership on **every** request afterwards — so even a
mis-minted cookie could not be used. Two gates; the picker is UX, not authorization.

> 🔑 **The re-mint carries the current token's expiry forward. It never starts a fresh TTL.** Re-signing with
> a full session lifetime would let anyone keep a session alive **indefinitely** by switching orgs — a
> session-lifetime bypass hiding inside a convenience feature. It also **fails closed** on a missing,
> unverifiable, or expired cookie rather than falling back to the default TTL. `remintSessionForOrg` is the
> single implementation, shared by the switcher and "leave org", because this is a rule that is easy to get
> wrong twice.

## Divergence from the plan

The plan proposed an **identity-only session** (drop `org` from the token; carry the org in the URL and
resolve it per request). We did not do that, for two reasons:

- The plan itself concedes that **the URL move is UX, not security** — a URL segment is client input exactly
  like a form field, and would be validated identically. It buys shareable links and back-button semantics.
- `requireOrgAccess` already re-validates membership **per request**, which is the property the identity-only
  session was reaching for. The wrong-org write it feared is prevented by the gate, not by where the org is
  stored.

`/org/{slug}` remains available as a later, purely-UX refactor. It is not a prerequisite for anything here.

## Consequences

- "Which orgs am I in?" is answerable for the first time — which is what made **ADR-0114** (consent-time org
  selection) and the cross-org last-owner guard possible at all. The latter fixed a **reachable** bug: an
  owner-role invite could leave someone the sole owner of an org that was not their own, and deleting their
  account then orphaned it (zero owners: RLS-unreachable forever, still billed, alerts silently gone).
- `memberships` reads must **continue** to name `org_id` explicitly. That is no longer load-bearing against an
  escalation (there is no permissive policy), but it remains the house rule, and `readMembershipRole` is the
  one role read.
- The directory adds an index on `memberships (user_id)`; the primary key leads with `org_id`, so a
  user-keyed lookup would otherwise seq-scan.
