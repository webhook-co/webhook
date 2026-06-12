/**
 * Theme renderer — emits the runtime CSS custom properties from the typed tokens.
 *
 * `renderThemeCss()` is the single producer of `styles/theme.css`. Theme-invariant
 * tokens (ink, radii, spacing, type, motion) live in `:root`; theme-variant tokens
 * (surfaces, text, borders, state, shadows) appear in both `:root` (light, the
 * canonical brand) and `[data-theme="dark"]`.
 *
 * Every variable is namespaced with {@link CSS_VAR_PREFIX} so the system never
 * collides with host-app or third-party variables.
 */

import { ink } from "./ink";
import { dark, light, type SemanticTheme } from "./semantic";
import { focusRing, radius, shadowDark, shadowLight } from "./elevation";
import { container, space } from "./spacing";
import { fontFamily, fontSize, fontWeight, leading, tracking } from "./typography";
import { cubicBezier, duration, easing } from "./motion";

/** All design-system CSS variables are prefixed with this, e.g. `--wh-surface-page`. */
export const CSS_VAR_PREFIX = "wh";

type Decls = Array<readonly [string, string]>;

/**
 * Build a namespaced CSS variable name, normalizing the segment to kebab-case so it is
 * always a valid custom-property identifier (camelCase token keys become kebab; the
 * fractional spacing keys like `0.5` become `0-5`).
 */
function v(name: string): string {
  const segment = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/\./g, "-")
    .toLowerCase();
  return `--${CSS_VAR_PREFIX}-${segment}`;
}

function block(selector: string, decls: Decls, indent = "  "): string {
  const body = decls.map(([name, value]) => `${indent}${name}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

/** Tokens that never change between themes. */
function invariantDecls(): Decls {
  const decls: Decls = [];

  for (const [stop, hex] of Object.entries(ink)) {
    decls.push([v(`ink-${stop}`), hex]);
  }

  decls.push([v("font-sans"), fontFamily.sans]);
  decls.push([v("font-mono"), fontFamily.mono]);
  for (const [name, value] of Object.entries(fontSize)) {
    decls.push([v(`text-${name}`), value]);
  }
  for (const [name, value] of Object.entries(fontWeight)) {
    decls.push([v(`weight-${name}`), value]);
  }
  for (const [name, value] of Object.entries(tracking)) {
    decls.push([v(`tracking-${name}`), value]);
  }
  for (const [name, value] of Object.entries(leading)) {
    decls.push([v(`leading-${name}`), value]);
  }

  for (const [name, value] of Object.entries(space)) {
    decls.push([v(`space-${name}`), value]);
  }
  decls.push([v("container-max"), container.max]);
  decls.push([v("container-prose"), container.prose]);

  for (const [name, value] of Object.entries(radius)) {
    decls.push([v(`radius-${name}`), value]);
  }

  for (const [name, points] of Object.entries(easing)) {
    decls.push([v(`ease-${name}`), cubicBezier(points)]);
  }
  for (const [name, ms] of Object.entries(duration)) {
    decls.push([v(`dur-${name}`), `${ms}ms`]);
  }

  // Focus ring references theme-variant vars, so it adapts without being redefined.
  decls.push([v("focus-ring"), focusRing]);

  return decls;
}

/** Tokens whose values differ between light and dark. */
function semanticDecls(theme: SemanticTheme, shadows: Record<string, string>): Decls {
  const decls: Decls = [];

  decls.push([v("surface-page"), theme.surface.page]);
  decls.push([v("surface-card"), theme.surface.card]);
  decls.push([v("surface-sunken"), theme.surface.sunken]);
  decls.push([v("surface-raised"), theme.surface.raised]);
  decls.push([v("surface-inverse"), theme.surface.inverse]);

  decls.push([v("text-primary"), theme.text.primary]);
  decls.push([v("text-secondary"), theme.text.secondary]);
  decls.push([v("text-muted"), theme.text.muted]);
  decls.push([v("text-faint"), theme.text.faint]);
  decls.push([v("text-on-inverse"), theme.text.onInverse]);

  decls.push([v("border-hairline"), theme.border.hairline]);
  decls.push([v("border-strong"), theme.border.strong]);
  decls.push([v("border-focus"), theme.border.focus]);

  for (const [name, tones] of Object.entries(theme.state)) {
    decls.push([v(name), tones.fg]);
    decls.push([v(`${name}-bg`), tones.bg]);
    decls.push([v(`${name}-border`), tones.border]);
  }

  theme.chart.forEach((hex, i) => {
    decls.push([v(`chart-${i + 1}`), hex]);
  });

  for (const [name, value] of Object.entries(shadows)) {
    decls.push([v(`shadow-${name}`), value]);
  }

  return decls;
}

/** Render the full theme stylesheet as a string. */
export function renderThemeCss(): string {
  const header =
    "/* webhook.co design tokens — GENERATED from packages/ui/src/tokens.\n" +
    "   Do not edit by hand: edit the TypeScript source and run `pnpm --filter @webhook-co/ui gen:theme`.\n" +
    "   Light is the canonical brand; dark is a first-class product preference. */";

  const root = block(":root", [...invariantDecls(), ...semanticDecls(light, shadowLight)]);
  const darkBlock = block('[data-theme="dark"]', semanticDecls(dark, shadowDark));

  return `${header}\n\n${root}\n\n${darkBlock}\n`;
}
