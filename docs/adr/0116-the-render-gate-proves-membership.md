# ADR-0116: The render gate proves **membership**, not identity

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-0023 (the DAL gate), ADR-0021 (no middleware), ADR-0113 (the org directory), ADR-0115 (atomic revocation)
- **Corrects:** a claim made in ADR-0113 and ADR-0115 that was true of server actions and **false of page renders**

## Context

`verifySession()` proves **identity**: the session cookie is validly signed and un-expired. `requireOrgAccess()`
proves identity **and current membership**, re-read from the database on that request.

They are not interchangeable, and the difference is load-bearing, because the app. session is **stateless** — a
signed cookie, a 7-day TTL, and **no server-side revocation store**. The org it names is a claim made once, at
mint time, and nothing re-examines it. RLS does not help: RLS proves a query was scoped to the org the query
**named**, never that the caller belongs to it.

Lane 2.2 applied `requireOrgAccess` to the server **actions**. The **pages were never converted.** Every page
under `(app)/` — and the `(app)/layout.tsx` render gate itself — called `verifySession()` alone. Only `/audit`
did otherwise. `dal-gate-guard.mjs` accepted **either** function, so nothing failed.

The result was a live cross-tenant read:

> Remove a member. Nothing touches their cookie — it cannot be revoked, and stays cryptographically valid for
> the rest of its 7-day life. Their **writes** are correctly refused (the actions gate). Their **reads** are
> not: they keep rendering the org's endpoints, events, deliveries, and **webhook payloads** until the cookie
> expires.

The same hole admits any cookie whose org outlived the membership that justified it.

ADR-0113 asserted *"`requireOrgAccess` then re-checks membership on **every** request afterwards — so even a
mis-minted cookie could not be used."* ADR-0115 asserted *"web access dies on the next request."* Both were
true of actions and **false of renders**. This ADR makes them true.

**No unit test could have caught it, by construction: the page tests mock the gate.** It was found by the
first end-to-end run of the new `apps/web` Playwright suite, which drives a real Chromium against a real
`next dev` against a real Postgres — with the app connecting as the **non-superuser `webhook_app` role**,
because the superuser bypasses every RLS policy and a suite booted as it would go green while proving nothing.

## Decision

**Inside `(app)/`, `requireOrgAccess()` is the gate. `verifySession()` alone is not.**

- The render gate (`(app)/layout.tsx`) calls it.
- **Every page calls it too.** The layout is necessary but **not sufficient**: Next renders a layout and its
  page **concurrently**, so a layout's refusal does not prevent the page's tenant query from having already
  run. Each page gates for itself.
- It is wrapped in React's `cache`, so the layout and page share **one** membership read per request rather
  than issuing one each.
- `dal-gate-guard.mjs` enforces exactly this: within `(app)/`, only `requireOrgAccess` counts, and a page with
  neither it nor an explicit `// dal-gate-allow:` marker **fails lint**. The only two markers are pure
  redirect stubs that own no tenant data.

## Consequences

- A removed member's live session stops reading the org on their **very next request**, which is what
  ADR-0115's atomic revocation always claimed and now actually gets.
- The gate costs one membership read per request. `cache` keeps it at one regardless of how many components
  ask.
- **The durable lesson is about the test, not the code.** A gate mocked by the tests that are supposed to
  cover it is a gate nobody is testing — the mock asserts the gate's *shape*, never its *effect*. The suite
  that found this asserts on the **bytes in the response**, not on a status code and not on a call being made,
  because the disclosure is the bytes. Every authorization guard needs at least one test at a layer that
  cannot mock it away.
