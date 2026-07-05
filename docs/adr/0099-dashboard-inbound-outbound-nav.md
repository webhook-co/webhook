# ADR 0099 — dashboard sidebar grouped Inbound/Outbound; Deliveries reordered + reframed

- status: accepted
- date: 2026-07-05
- scope: `apps/web` (dashboard nav + the global deliveries page copy)
- review severity: low (IA + copy only; no data, auth, or route changes)

## context

The dashboard sidebar was a single "Workspace" group ordered **Endpoints → Deliveries → Destinations**.
That ordering is backwards: a delivery is the *result* of sending a captured event to a destination, so
it can't exist before a destination — yet it was listed above one. The order was an artifact of build
sequence (the global Deliveries view shipped in S1 slice 1, before Destinations management in slice 2),
not a deliberate IA decision.

Separately, the top-level **Deliveries** section reads as a peer object to Destinations, when a
per-destination deliveries embed already lives on each destination's detail page (S1 slice 3b). Its real
role is a **cross-destination monitor** — the only surface that spans every destination *and* includes
the null-destination one-off localhost-tunnel replays.

## decision

1. **Group the sidebar by direction.** Endpoints (what you receive) under an **Inbound** section;
   Destinations + Deliveries (where you send, and how those sends fared) under an **Outbound** section;
   Settings stays under **Account**. This reuses the existing `AppNavSection` primitive — the domain
   vocabulary already maps this way (`server/deliveries.ts` calls deliveries "the OUTBOUND half").
2. **Order Destinations before Deliveries** within Outbound — targets precede results.
3. **Reframe the global Deliveries page copy** to signal the cross-destination monitor role ("Every
   delivery attempt across all your destinations, including one-off replays. Open a destination to see
   just its deliveries.") — pointing users to the per-destination embed for the drill-down.

## consequences

- **Kept the `/deliveries` route + `/deliveries/[id]` detail unchanged.** The detail route is shared by
  the per-destination embed's row links, so moving the path would break the embed; only nav grouping,
  order, and page copy change. Label stays "Deliveries" (a rename to "Activity" was considered and
  declined — the noun is accurate once it's correctly placed under Outbound).
- Pure IA/copy change: no loader, action, auth, or data-model impact; `isActive` is per-item and
  order-independent. Covered by the nav test in `app/(app)/layout.test.tsx`.
