# ADR 0100 — reusable Tabs primitive; Manage Credentials reordered + active/inactive split

- status: accepted
- date: 2026-07-05
- scope: `packages/ui` (new `Tabs`, `Table` `dense` prop), `apps/web` (credentials view)
- review severity: low (UI structure only; no data, auth, or loader changes — the secret-redaction
  invariant is unchanged and still covered by tests)

## context

The Settings → Manage Credentials page rendered Authorized devices *above* API keys, and showed revoked /
expired credentials inline (greyed out), which padded the page with dead rows. Founder asked to (1) put
API keys first, (2) move revoked credentials into a separate view, and (3) compact the layout.

`packages/ui` had **no** tabs/segmented-control primitive.

## decision

1. **New reusable `Tabs` primitive** (`packages/ui/src/components/tabs.tsx`) — a thin house-styled wrapper
   over `@radix-ui/react-tabs` (keyboard + ARIA for free, inactive panels unmounted), matching the
   existing Radix-wrapper pattern (`dialog`/`popover`/`dropdown-menu`). Exported from the package barrel.
2. **Restructure `credentials-view.tsx`:** API keys grouping renders **above** Authorized devices; both
   groupings sit inside an **Active | Inactive** tab split. Active = live keys (`!revokedAt`) + active /
   pending grants; **Inactive** = revoked keys + revoked/expired grants (labeled "Inactive", not
   "Revoked", so an expired grant isn't mislabeled — truthfulness over the literal ask). The Inactive tab
   carries a count. Dead credentials carry no revoke affordance, so the inactive groupings pass no revoke
   handler. Client-side split over the already-eagerly-loaded arrays — no loader/action change.
3. **`Table` `dense` prop** for compact, metadata-heavy lists — applied as descendant utilities on the
   `<table>` element (NOT via context): `TableHead`/`TableCell` stay context-free so `Table` remains a
   server-safe primitive. (A first attempt used a module-level `React.createContext`, which pulls the
   design-system into the RSC/client graph and broke the non-React `/api/provider-icon` + `/_not-found`
   builds — the descendant-utility approach avoids that entirely.)

## consequences

- **`/api/provider-icon` now imports `PROVIDER_DOMAINS` via the leaf `@webhook-co/ui/provider-branding`,**
  not the package barrel (new leaf export). An edge/route module must not pull the React barrel — doing so
  eagerly evaluates client-only modules. (See the turbopack-contract-barrel gotcha.)
- Revoking a live credential moves it from the Active tab to Inactive (the optimistic in-place status
  flip already did this; the tab split just relocates it). Tests updated to switch tabs after revoke.
- No change to the secret-redaction invariant (only the redacted prefix is ever rendered) or to authz.
