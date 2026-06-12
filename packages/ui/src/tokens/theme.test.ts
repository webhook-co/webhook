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

  it("emits a :root (light) block and a dark block", () => {
    const css = renderThemeCss();
    expect(css).toContain(":root {");
    expect(css).toContain('[data-theme="dark"] {');
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
