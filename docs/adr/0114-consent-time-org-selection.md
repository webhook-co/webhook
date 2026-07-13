# ADR-0114: The acting org is **chosen at consent**, not derived from the user

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-0030 (authorize/consent/mint), ADR-0031 (device authorization), ADR-0113 (the org directory)

## Context

`getConsentOrg(userId)` **derived** the org: it returned `personalOrgId(userId)`. It was also the **single
org-selection point in the entire issuer** — `/authorize`, the device flow, and the web session handoff all
funnelled through it, and everything downstream merely *carries* what it returned:

```
getConsentOrg → consent ticket → props.orgId → auth_grant.org_id → rtk_<orgId>_… → the app. session cookie
```

So once invites shipped, an invited teammate who authorized the CLI or an MCP client landed in **their own
empty personal org** — silently breaking the webhook→agent trigger for exactly the people invites exist for.

Notably, nothing *downstream* was wrong: `token-core` already asserts `isOrgMember(props.userId,
props.orgId)` at the mint — **not** "is this the personal org". A real invited org would have passed every
check. The blocker was purely that **no query could enumerate a user's orgs** (ADR-0113).

## Decision

**Org resolution is a selection, not a derivation.** `listConsentOrgs(userId)` returns the user's orgs
(personal pinned first). The **first is the default**; the **whole list is sealed into the signed consent
ticket**. The consent screen renders a picker when there is more than one org — and the device flow reuses
that same screen, so it inherits the picker.

### The picked org is untrusted page input

`decideConsent` validates it **against the list sealed in the ticket** (built from the user's live memberships
at `/authorize` time) and refuses anything else with `access_denied`, minting nothing. A tampered form can
select **from** the user's orgs but never introduce one. `token-core` still re-asserts membership at the mint,
so this is the **outer of two independent gates**.

The ticket is HMAC'd over the whole payload, so `orgs` can be neither stripped nor forged.

### `orgs` is additive on the ticket — deliberately

A ticket signed by the **previously-deployed** code carries no list, and those tickets sit on users' screens
during a rolling deploy. A missing list is treated as **"the sealed default, and only that"** — a
one-element allowlist. Old tickets therefore still approve (into their own org, and nothing else) instead of
`500`ing.

> This is the same class of mistake as a version bump that 401s every live session mid-deploy. Any change to
> a ticket/envelope shape must ask: *what happens to the ones already in flight?*

## Consequences

- 🔑 **Deleting a derivation removes a guarantee somewhere else.** The device-token path carried **no**
  membership check, because the org used to be derived from the approver — its comment said membership was
  "guaranteed by construction". That construction argument died with `getConsentOrg`. What still stopped a
  removed member was the mint ceiling collapsing to zero scopes: a scope mechanism two packages away,
  load-bearing *by accident*. `redeemDeviceCode` now asserts `isOrgMember` explicitly, like the auth-code
  path. **When you delete a derivation, grep for who was relying on it.**
- **"Personal org first" is pinned explicitly**, not inferred from `created_at` order. Bootstrap self-heals on
  a *later* session-create, so a user whose signup bootstrap failed and who then accepted an invite has the
  **team** membership as their oldest — and would have silently defaulted to authorizing apps into someone
  else's org. `personalOrgId` is derivable without a read, so pinning it costs nothing.
- The **web session handoff** lands in the default org. Choosing a different one in the dashboard is the org
  switcher (ADR-0113), not the issuer's job.
