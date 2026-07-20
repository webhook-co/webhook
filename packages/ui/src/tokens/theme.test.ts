import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ink } from "./ink";
import { dark, light } from "./semantic";
import { CSS_VAR_PREFIX, renderThemeCss } from "./theme";

// Vitest runs from the package root, so resolve the committed artifact from cwd.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed in-repo path, not user input.
const committedCss = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");

describe("renderThemeCss", () => {
  it("matches the committed theme.css (run `pnpm --filter @webhook-co/ui gen:theme` to update)", () => {
    expect(committedCss).toBe(renderThemeCss());
  });

  it("namespaces every variable with the prefix", () => {
    const declared = renderThemeCss().match(/--[\w-]+(?=:)/g) ?? [];
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(name.startsWith(`--${CSS_VAR_PREFIX}-`)).toBe(true);
    }
  });

  it("makes :root the dark default, with explicit light and dark override scopes", () => {
    const css = renderThemeCss();
    const rootAt = css.indexOf(":root {");
    const lightAt = css.indexOf('[data-theme="light"] {');
    const darkAt = css.indexOf('[data-theme="dark"] {');

    // All three scopes exist, in order: :root, then the two attribute overrides. The dark override is
    // kept (identical to :root) because a local island — e.g. the marketing terminal — sets
    // data-theme="dark" on a subtree to force dark inside a light-scoped page.
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(lightAt).toBeGreaterThan(rootAt);
    expect(darkAt).toBeGreaterThan(lightAt);

    // The bare :root — the no-attribute default, what shows before the init script stamps data-theme
    // — is DARK, so the default is honest even with no JS. It also pins native chrome dark.
    const rootBlock = css.slice(rootAt, lightAt);
    expect(rootBlock).toContain(`--${CSS_VAR_PREFIX}-surface-page: ${dark.surface.page};`);
    expect(rootBlock).toContain("color-scheme: dark;");

    // The explicit light scope carries the light palette and light native chrome.
    const lightBlock = css.slice(lightAt, darkAt);
    expect(lightBlock).toContain(`--${CSS_VAR_PREFIX}-surface-page: ${light.surface.page};`);
    expect(lightBlock).toContain("color-scheme: light;");
  });

  it("includes the full ink scale with its hex values", () => {
    const css = renderThemeCss();
    for (const [stop, hex] of Object.entries(ink)) {
      expect(css).toContain(`--${CSS_VAR_PREFIX}-ink-${stop}: ${hex};`);
    }
  });

  it("places functional state colors in both themes", () => {
    const css = renderThemeCss();
    expect(css).toContain(`--${CSS_VAR_PREFIX}-ok: ${light.state.ok.fg};`);
    expect(css).toContain(`--${CSS_VAR_PREFIX}-ok: ${dark.state.ok.fg};`);
  });

  it("keeps the ink scale free of declared variables beyond the 14 stops", () => {
    const inkVars = renderThemeCss().match(/--wh-ink-\d+/g) ?? [];
    expect(new Set(inkVars).size).toBe(Object.keys(ink).length);
  });
});
