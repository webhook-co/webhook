# ADR-0126: dark theme is the default, independent of the OS

- **Status:** Accepted
- **Date:** 2026-07-20
- **Relates to:** ADR-0001 (web + design-system stack), `packages/ui` theme system
  (`src/components/theme-toggle.tsx`, `src/tokens/theme.ts`, `src/styles/theme.css`),
  `.cursor/rules/design-ux.mdc`

## Context

The design system has always carried both light and dark tokens, but the product default was the OS
`prefers-color-scheme`: the pre-paint `themeInitScript` and the `ThemeToggle` resolved an unstored
visitor to `matchMedia("(prefers-color-scheme: dark)")`. In the CSS, the bare `:root` was the *light*
palette and only `[data-theme="dark"]` overrode it — so "the default" was light-in-CSS, OS-derived-in-JS.

We want a deliberate, brand-first **dark** default across the product surfaces (the marketing site
`apps/www`, the dashboard `apps/web`, and auth `apps/auth`), while keeping the light/dark toggle so any
user can switch. The open question was how the default should interact with the visitor's OS setting.

## Decision

**Dark is the default on first visit, independent of the OS `prefers-color-scheme`.** A stored
`wh-theme` preference (set by the `ThemeToggle`) and the toggle itself always win.

1. **Resolution (JS).** `themeInitScript` and `ThemeToggle` resolve an unstored visitor to `dark`;
   only an explicit stored `"light"` opts out. `systemTheme()`/`matchMedia` is removed — the OS is not
   consulted for the default. The pre-paint script still stamps `data-theme` on `<html>` before paint
   to prevent a flash.
2. **Resolution (CSS).** The bare `:root` now carries the **dark** tokens (the honest default, shown
   before the script runs or with JS disabled). `[data-theme="light"]` is an explicit light override;
   `[data-theme="dark"]` is kept (identical to `:root`) so a local dark island — e.g. the marketing
   `terminal.tsx` — can force dark inside a light-scoped page. Each scope pins `color-scheme` so native
   chrome (scrollbars, form controls) follows the theme rather than the OS.
3. **Scope.** The shared change flips all three Next.js surfaces at once (they inject the shared
   script). The Mintlify docs site (`apps/docs`) defaults to dark via `appearance.default` while keeping
   its toggle. `apps/play` and `apps/get` are HTML-less Cloudflare Workers and are unaffected.

## Consequences

- A first-time visitor whose OS is set to light still sees dark; the toggle is the escape hatch, and
  the choice persists under `wh-theme`.
- Accessibility is covered in **both** palettes: the Playwright axe suites seed `wh-theme` explicitly
  (`light` for `a11y.spec.ts`/`a11y-desktop.spec.ts`, `dark` for `a11y-dark.spec.ts`) and assert the
  rendered `data-theme`, so neither scan is coupled to the default.
- The `color-scheme` handling is centralized in the generated `theme.css`; `apps/web`'s local block was
  removed as redundant.
