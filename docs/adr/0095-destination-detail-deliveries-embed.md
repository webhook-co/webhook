# ADR 0095 — destination detail page + per-destination deliveries embed

> renumbered from 0094 (the S7 Python-SDK slice, #353, claimed 0094 on main first).

- status: accepted
- date: 2026-07-04
- scope: `apps/web`
- review severity: low (read-only view reusing shipped reads; RLS is the tenant boundary)

## context

The S1 dashboard-gaps lane's deliveries IA was set to **both** a global view and a **contextual**
(per-destination) embed. Slice 1 shipped the global `/deliveries` view; Slice 3a shipped replay-to-
destination. This final slice (3b) closes the "contextual" half: a per-destination detail route that shows
the destination plus the deliveries scoped to it. Pure view — no contract, migration, or infra change; the
`deliveries.list` `destination_id` filter and its covering index (migration 0036, PR #346) already exist.

## decision

1. **A `/destinations/[id]` detail route.** `verifySession()` → resolve the destination + its deliveries
   concurrently (`Promise.all`) under RLS → render a summary (url / label / honest status pill / ordered /
   created) + a "deliveries to this destination" list. A non-uuid or cross-org / unknown id is `notFound()`
   (no existence oracle — RLS makes a foreign id simply absent).
2. **Resolve the destination by filtering the existing list read.** There is no single-full-record db read
   (`getReplayDestination` returns only `{id,url}` for the replay path); rather than add one, the page filters
   `loadDestinations().items` by id — matching existing web patterns and adding no db surface.
3. **Reuse `DeliveriesList` with the destination scope threaded.** `DeliveryFilterParams` gains an optional
   `destinationId` (uuid-validated in `parseDeliveryFilters`, dropped otherwise so a bad value never reaches
   the `destination_id = $1` predicate as a 22P02). The embed passes `filterParams={{ destinationId }}`, so the
   existing `loadMoreDeliveriesAction` keeps "Load older" scoped to the destination with no new action. The
   client-supplied `destinationId` on the load-more boundary is RLS-scoped (an org's own destinations only),
   exactly like the existing `status` filter. `isFiltered={false}` for the embed — the destination scope is
   intrinsic, not a user-applied filter, so an empty list reads as the honest "none yet", not "no match".
4. **Each destinations-list row links to its detail page** (a real `<Link>`), without disturbing the row
   actions or the double-fire latch.

## consequences

- The S1 dashboard-gaps deliveries IA ("both global + contextual") is complete.
- No per-endpoint deliveries embed (ADR-0089) — `delivery_attempts` has no `endpoint_id`; the contextual
  view is correctly keyed on the destination.
