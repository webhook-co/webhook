# @webhook-co/ui

The webhook.co design system: tokens, theming, motion conventions, and React
primitives. One source of truth for the look and feel across every surface — web app,
embeddable portal, and anywhere else that needs a color, a duration, or a button.

It's monochrome on purpose. Infrastructure shouldn't perform; restraint is the pitch.

## Principles

Three principles decide everything. If a choice doesn't serve one, it doesn't ship.

- **Trustworthy** — earn trust through restraint. The palette is a single greyscale
  ramp. Color appears only when it carries information.
- **Fast** — fast is a feeling. Product motion answers in 180 ms or less on decisive
  ease-out curves. Nothing bounces, nothing lingers, exits beat entrances.
- **Precise** — machined, not decorated. Every value is a token on a 4px grid. If a
  value isn't a token, it doesn't ship.

### The functional-color-only rule

This is the load-bearing constraint, so it gets its own heading.

The entire UI is built from one cool-slate **ink** scale. There is no brand accent
color: links are ink, the primary button is inverse ink. The only chroma in the
product is **functional state** — `ok` (green), `warn` (amber), `danger` (red), and
`info` (blue) — plus a deliberately desaturated five-hue ramp for data viz. When
something turns red here, it means something. Never use a functional color for
decoration or as a pseudo-accent.

## What's inside

```
src/
  tokens/      typed token source of truth (ink, semantic, type, spacing, elevation, motion)
  motion/      Motion (motion.dev) conventions — transitions and variants from the tokens
  components/  React primitives (button, input, card, badge, status pill, mark, wordmark)
  lib/         the cn() class merger
  styles/      theme.css (generated), preset.css (Tailwind theme), base.css
assets/        the mark, inverse mark, favicon, and app tile
```

## Tokens

Tokens are defined once as typed TypeScript and emitted to CSS custom properties. Edit
the TypeScript; never hand-edit the generated stylesheet.

```ts
import { ink, light, dark, duration, easing } from "@webhook-co/ui/tokens";
```

The runtime variables are all namespaced `--wh-*` (e.g. `--wh-surface-card`,
`--wh-text-primary`, `--wh-dur-base`). To regenerate `styles/theme.css` after changing
a token:

```sh
pnpm --filter @webhook-co/ui gen:theme
```

A drift test fails CI if the committed CSS ever diverges from the typed source, so the
two can't silently disagree.

## Theming

Light is the canonical brand surface; dark is a first-class product preference. Both
live in the token layer. Dark is activated by `data-theme="dark"` on any ancestor
(usually `<html>`):

```html
<html data-theme="dark">
```

Because the Tailwind theme maps utilities to the live CSS variables, switching the
attribute swaps the entire surface — no recompiled classes. The marketing site stays
light-only; the app earns a real toggle.

## Wiring it into an app (Tailwind v4)

In your global stylesheet, after importing Tailwind:

```css
@import "tailwindcss";
@import "@webhook-co/ui/styles/theme.css"; /* the --wh-* variables + dark overrides */
@import "@webhook-co/ui/styles/preset.css"; /* maps Tailwind utilities to the tokens */
@import "@webhook-co/ui/styles/base.css"; /* optional page defaults + reduced-motion */

/* Tailwind can't see class names inside node_modules; point it at the package source. */
@source "../path/to/packages/ui/src/**/*.{ts,tsx}";
```

This gives you token-backed utilities: `bg-surface-card`, `text-fg-secondary`,
`border-hairline`, `text-ok`, `rounded-card`, `shadow-2`, `font-mono`, `tracking-heading`,
and the rest.

## Components

```tsx
import { Button, Card, Input, Label, StatusPill, Wordmark } from "@webhook-co/ui";

<Button>Start free</Button>
<Button variant="secondary">Read the docs</Button>
<Button variant="danger">Delete endpoint</Button> // the one case a button carries color

<StatusPill status="delivered" /> // derives the tone; green carries the meaning
<StatusPill status="failed" />
```

The control vocabulary is small on purpose: a solid inverse-ink `primary`, a hairline
`secondary`, a text-only `ghost`, and a `danger`. No gradients, no glow, no scale or
ripple — hover is a tint, press is a 0.5px nudge, focus is an always-visible ring.

## Motion

Motion conventions come from the same tokens, so the engine never invents timing.

```tsx
import { fadeInUp, productTransition, prefersReducedMotion } from "@webhook-co/ui/motion";
```

Three tiers: **product** (80–180 ms, swift, no spring — fast is the brand),
**marketing** (280–420 ms, smooth, staggered), and the **signature** mark draw-on.
`prefers-reduced-motion` is honored unconditionally — entrances resolve instantly and
loops stop. Nothing essential ever depends on motion.

## Do / never

- **Do** let green / amber / red / blue carry state, and only state.
- **Do** render ids, urls, and timestamps in the mono face.
- **Do** reach for whitespace before a divider, a hairline before a shadow.
- **Never** add a brand accent color, gradient, or glow.
- **Never** use Title Case or capitalize "Webhook". The name is lowercase: webhook.co.
- **Never** scale-on-hover, ripple, or bounce (the switch is the only overshoot).

## A note on visual verification

This package is logic-tested (tokens, variants, behavior), but rendering, layout, and
exact look and feel are not something tests can vouch for. Any change to appearance
needs a human to eyeball it in light and dark before it's considered done — see the
showcase at `/design` in the web app.
