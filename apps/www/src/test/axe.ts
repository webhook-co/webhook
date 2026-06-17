import type { AxeResults } from "axe-core";
import { axe } from "vitest-axe";

/**
 * Run axe-core against a rendered component for a **semantics** smoke test: accessible names,
 * roles, valid ARIA, duplicate ids, etc.
 *
 * This is a jsdom scan, so be honest about what it CANNOT see — and therefore what is verified
 * elsewhere rather than here:
 * - **Color contrast** (`color-contrast`) — jsdom has no layout/CSS, so axe disables it. Real
 *   contrast is checked by the `@axe-core/playwright` job (`playwright/a11y.spec.ts`).
 * - **Document-scope rules** — a component renders as a detached fragment with no `<html lang>`,
 *   `<title>`, or page landmarks, so those rules can't pass here. They're verified by the
 *   real-browser scan and the built-HTML SEO check. We disable them so they don't false-fail.
 */
export function axeComponent(container: Element): Promise<AxeResults> {
  return axe(container, {
    rules: {
      region: { enabled: false },
      "landmark-one-main": { enabled: false },
      "page-has-heading-one": { enabled: false },
      "document-title": { enabled: false },
      "html-has-lang": { enabled: false },
    },
  });
}
