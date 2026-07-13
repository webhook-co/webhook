# ADR-0117: URL-authoritative organizations (`/org/{slug}`), and the slug lifecycle

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-0021 (no middleware), ADR-0023 (the DAL gate), ADR-0116 (the render gate proves membership)
- **Amends:** ADR-0113 — see _Correction_

## Context

The dashboard derived the acting org from the **session cookie**. There is one cookie per browser, so once
the org switcher shipped (ADR-0113), a second tab that switched orgs silently retargeted the first tab's
writes:

> Tab A open on Org Alpha. In Tab B you switch to Org Beta (cookie ← Beta). Back in Tab A — still rendering
> Alpha — you click **Create endpoint**. The action reads the cookie, sees **Beta**, and creates the endpoint
> in the **wrong organization**.

RLS does not save you: the user *is* a member of Beta, so the write is authorized — just aimed at the wrong
place. The same held for minting an API key, sending an invite, changing a role.

## Decision

**The acting org lives in the URL: `/org/{slug}/…`. The cookie's `orgId` is demoted to a "default org" hint,
read in exactly one place (`/`, the post-login landing) and never authoritative.**

The org a page renders and the org its actions mutate are now the same string, in the address bar. The
wrong-org write is unrepresentable.

### Where the safety lives — the keystone

A slug in the path is untrusted input, exactly like a hidden form field. What makes it safe is not that it is
validated but **where** it is resolved.

A *global* slug → orgId lookup is **structurally impossible** for `webhook_app`: its only `orgs` SELECT policy
is `id = current_org_id()`, so `select id from orgs where slug = $1` returns zero rows. The tempting fix — a
permissive policy so any slug can be looked up — is precisely the privilege escalation ADR-0113 was written to
eliminate (Postgres policies are permissive and OR together).

So the slug is resolved **inside the caller's own directory** (`user_org_directory()`, bounded by
`current_app_user()`). Two properties follow, and they are the whole design:

- **Resolution and the membership check are the same operation.** They cannot drift apart, because there is
  only one of them. There is no path on which a slug resolves but membership goes unchecked.
- **There is no enumeration oracle — by construction.** A slug you don't belong to is indistinguishable from
  one nobody ever registered: the resolver never sees either. A miss is `notFound()`, never `403` (an oracle),
  and never `redirect(LOGIN)` (which would infinite-loop on a bookmarked foreign-org URL).

`requireOrgAccess(slug, subPath?)` is the gate. Pages pass `subPath` (their path *and query string*) so a
mis-cased or **retired** slug 308s to the canonical URL with the deep link intact; actions omit it and resolve
straight through — a form posted seconds before a rename must still act on the right org.

### The slug is a real identifier now

`orgs.slug` was a write-only column. It has become the org's URL, so it carries the invariants a URL needs
(migration 0069): 3–40 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen, never all-numeric,
and a reserved-word denylist (`/org/new` must mean "create an org", not "the org called new"). The same rules
live in `@webhook-co/shared` (`validateOrgSlug`) for live UI validation and friendly server rejection; a
real-Postgres parity test asserts the two authorities never drift.

### The slug lifecycle: create, rename, never-recycle

- **Create** (`/org/new`): any authenticated user may create a team and becomes its owner (gated on
  `verifySession`, not membership — the org doesn't exist yet). The slug is derived from the name; a
  collision is retried with a fresh suffix.
- **Rename** (settings, owner/admin only): name, slug, or both. The DB is the authority; a taken slug — live
  **or retired** — is refused.
- **Never recycle.** A rename retires the old slug forever. It keeps redirecting (the former-slug 308), and it
  can **never** be claimed by another org — that is GitHub's documented account-takeover bug, closed here by a
  trigger, not a check the app has to remember (migration 0069). **The database writes the history table; the
  application cannot, and therefore cannot lie about it** — an earlier draft that let the app insert its own
  history rows was a namespace-squatting hole, caught before it shipped.

Every create and rename appends a tamper-evident `auth_audit_event` (`org_created` / `org_renamed`) in the
same transaction as the mutation, so the trail can never disagree with the state.

## Correction to ADR-0113

ADR-0113 §Divergence concluded: *"the URL move is UX, not security … `/org/{slug}` remains available as a
later, purely-UX refactor. It is not a prerequisite for anything here."*

**That was true only until the switcher shipped in that same lane.** The switcher is what turned the latent
wrong-org write into a live one — a second tab could silently retarget the first's writes, and no per-request
membership check prevents it, because the user genuinely *is* a member of the org the cookie names. The URL
move is not UX; it is the fix. This ADR supersedes that conclusion.

## Consequences

- The org switcher is a `<Link>`, not a cookie re-mint — which **deleted `switchOrgAction`**, the only code
  path in the product that mutated a session's org, and an undocumented dependency on Next's
  `cookies().set()`-invalidates-the-Router-Cache behaviour that no test pinned.
- Every dashboard route is `/org/{slug}/…`. **Hard cutover** — the old paths are deleted, not redirected, so a
  legacy redirector can never re-introduce the cookie-guessing it exists to delete. `/` survives as the
  default-org resolver: it has no org because the user just authenticated, so choosing one is a defined
  product decision, not a guess.
- `/org/a/*` and `/org/b/*` are different Router-Cache keys and cannot alias; the back button lands on the org
  you were actually looking at.
- There is no middleware (ADR-0021), so the gate and the canonicalization live in the layout/page, and the
  sub-path is passed explicitly rather than read from the request.
