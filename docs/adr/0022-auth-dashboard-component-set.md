# ADR 0022 — the auth/dashboard component set (Lane E1)

- status: accepted
- date: 2026-06-19
- scope: `packages/ui`
- relates: [ADR-0001](0001-web-and-design-system-stack.md) (the design-system stack + `@webhook-co/ui`
  home — unchanged), [ADR-0021](0021-opennext-cloudflare-workers-app-and-auth.md) (the `app.`/`auth.`
  surfaces these primitives render on); the Lane E build-plan (`internal/build-plans/lane-e-auth-frontend.md`).

## context

`@webhook-co/ui` ships the marketing/design-system primitives (`Button`, `Input`, `Label`, `Card`, `Badge`,
`StatusPill`, `Mark`, `Wordmark`, `cn` + tokens). The auth-foundation epic adds two **dynamic, auth-gated**
human-UI surfaces — login/consent/device on `auth.` and the settings dashboard on `app.` — that need a small
set of additional primitives (form fields, overlays, a data table, feedback, a one-time-reveal copy control,
two shells). These are constitutional human-UI hard stops and, on the dashboard, credential-bearing trust
surfaces, so the primitives must be accessible by construction, not retrofitted.

Two failure modes to avoid: (a) over-building a generic kit ahead of any screen that needs it, and (b)
re-implementing behavior the package already provides (the `cva` variant system, the `--wh-*` tokens, the
`forwardRef` + `displayName` convention).

## decision

**Fill a v1-*minimal* primitive gap, composing the existing package — not a generic component library.**

- **Scope = only what a v1 screen renders.** Build `Field`, `Checkbox`, `Dialog`, `DropdownMenu`, `Table`,
  one of `Toast`/`Banner`, `Spinner`, `IconButton`, `CopyButton`, `AuthShell`, `AppShell`, and **move** the
  existing `ThemeToggle` + `themeInitScript` into the package. **Cut from v1** (add when a screen needs them):
  `Tabs`/`SegmentedControl`, `Avatar`, `Skeleton`, `Switch`, and whichever of `Toast`/`Banner` is unused.
- **Compose, don't rebuild.** New primitives wrap the shipped ones (`IconButton` reuses `Button` + its `cva`
  variants/sizes; `Field` composes `Input` + `Label`) and use only `--wh-*` tokens via the Tailwind
  utilities — never raw color, never a second variant system. Keep the design-system "never" list (no
  accent/gradient/glow, functional color only, lowercase brand, ≤180ms motion, honor `prefers-reduced-motion`).
- **Accessibility is part of the primitive, not the consumer's job.** Field errors render as a live region
  (`role="alert"`) so a validation error that appears after submit is announced even when focus is elsewhere;
  the `Spinner` carries `role="status"` + an accessible name and stops spinning under
  `motion-reduce`; `IconButton` requires `aria-label` at the type level. (Flow-level concerns the primitive
  can't own — e.g. announcing *completion* after a spinner — stay with the calling screen, documented on the
  component.)
- **Radix for the interactive overlays.** `Dialog`, `DropdownMenu`, and `Checkbox` are built on
  `@radix-ui/react-*` (focus-trap, roving tabindex, `aria-checked`) — the same shadcn-style Radix + `cva`
  basis ADR-0001 already chose — rather than hand-rolling keyboard/focus management.
- **Ship E1 as focused PRs, not one mega-PR.** Each PR is a small, independently reviewable cluster of
  primitives (this ADR lands with the first: `Field` + `Spinner` + `IconButton`). The Radix-overlay cluster
  carries the dependency add; every PR keeps the package's 80% coverage floor and the theme-drift guard green.

## consequences

- The auth/dashboard slices (E3–E6) consume a stable, accessible primitive vocabulary; a11y assertions live
  in the primitive's own RTL suite (e.g. the error `role="alert"`, the icon-button accessible name), so the
  screen tests cover composition rather than re-testing focus traps.
- `@radix-ui/react-dialog`/`-dropdown-menu`/`-checkbox` join `packages/ui` dependencies when the overlay
  cluster lands (Apache/MIT; consistent with the existing `@radix-ui/react-slot` dependency).
- The cut primitives are an explicit YAGNI deferral, not an omission — re-open this ADR if a later screen
  needs `Tabs`/`Avatar`/`Skeleton`/`Switch`.
- `ThemeToggle` becoming a package export (a move, not a rebuild) makes both new apps theme-consistent without
  copying the `wh-theme` init logic.
