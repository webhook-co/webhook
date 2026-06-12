# ADR 0001 — web app framework and design-system home

- status: accepted
- date: 2026-06-12
- scope: `apps/web`, `packages/ui`

## context

The dashboard is the auth-gated `app.` surface. The decided architecture pins the core to
Cloudflare Workers and TypeScript, with the web/dashboard hosted on Vercel and `api.` on Workers.
We need a documented design system that re-expresses our visual language (a monochrome cool-slate
ink scale, light + dark, chromatic color reserved for functional state and data viz) as first-class
code, shared cleanly across surfaces, without crossing the open-core boundary into `ee/`.

Three decisions were open: the framework for `apps/web`, the styling/component/animation stack, and
where the design system physically lives.

## decision

### web framework — Next.js (App Router) on Vercel

We use Next.js App Router, hosted on Vercel. It is the default the architecture already points at,
it is the framework Vercel supports best, and it gives us React Server Components, file-based
routing, and `next/font` self-hosting (no runtime font fetch, which matters for the
compliance-by-design posture). The scaffold used Vite only for stubbing; the dashboard is a real
multi-route app behind auth, so a full app framework earns its keep here.

The single most important trade-off: **Next.js couples us more tightly to Vercel than a portable
Vite SPA would.** We accept it because the dashboard is already a Vercel surface by decision, and
the coupling stays contained — `api.` and ingestion live on Workers behind their own boundaries, so
the framework choice for one surface does not leak into the engine. If we ever need to move, the
design system (tokens + primitives) is framework-agnostic and ports with us.

### styling — Tailwind CSS v4

Validated, not adopted blindly. Tailwind v4 is CSS-first: the theme is declared in CSS via `@theme`,
and our tokens are already CSS custom properties that flip under `[data-theme="dark"]`. That makes
the token layer the single source of truth and lets utilities resolve to live variables, so dark
mode is free. The v4 engine is fast, and utility classes keep the styling surface auditable (no
sprawling bespoke CSS). Alternative considered: hand-rolled CSS modules — rejected as more code to
maintain with weaker consistency guarantees.

### component layer — shadcn-style owned primitives (Radix + cva)

We build our primitives in the shadcn/ui style — components copied into our repo and owned by us,
composed from Radix UI behavior primitives and `class-variance-authority` for variants. We do **not
take a UI kit as a runtime dependency**, so the components read as wholly original webhook.co code,
are fully ours to restyle to the ink-scale system, and inherit Radix's accessibility (focus
management, keyboard nav, ARIA) for free. Alternative considered: a heavyweight component library —
rejected because it would fight our restrained, token-driven look and add opaque dependency weight.

### animation — Motion (motion.dev)

Validated. Motion for React covers the orchestration CSS can't express (staggered entrances, spring
physics, interruptible and scroll-linked motion) while honoring `prefers-reduced-motion`. CSS still
owns the cheap things (hover tints, press states). We export motion **tokens** (durations, easings)
from the design system so the engine never invents timing. Alternative considered: a larger
animation runtime — rejected as overkill for our motion budget.

### test runner — Vitest

Kept, per repo standard. Component logic is tested with Vitest + React Testing Library on a jsdom
environment; token integrity is tested by regenerating the CSS from the typed source and asserting
no drift. Coverage thresholds are enforced in the package's Vitest config, matching the existing
`packages/shared` gate.

## where the design system lives — `packages/ui`

The design system is a shared workspace package, `@webhook-co/ui`, not folded into `apps/web`.

- **Parity and reuse.** Both the dashboard (`apps/web`) and the embeddable customer portal
  (`packages/portal-sdk`) are React surfaces that need the same primitives and theme. A shared
  package is the only home that serves both without duplication.
- **One source of truth for tokens.** Tokens are defined once as typed values in TS and emitted to
  framework-agnostic CSS. Non-React surfaces (CLI/API/MCP) can import the same typed values when
  they need a color or duration, keeping the system consistent across CLI / API / web / MCP.
- **Open-core boundary intact.** `@webhook-co/ui` is Apache-2.0 and depends on nothing in `ee/`;
  self-host builds include it unchanged.

## consequences

- `apps/web` becomes a real Next.js app (build is `next build`); turbo `build`/`typecheck`/`test`
  now exercise it.
- Next's own lint-on-build is disabled in favor of the repo-wide ESLint gate, so there is exactly
  one lint authority (`pnpm lint`).
- The token CSS is generated from `packages/ui/src/tokens`; edit the TS source, not the emitted CSS.
