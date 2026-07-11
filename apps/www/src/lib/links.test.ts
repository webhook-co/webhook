import { describe, expect, it } from "vitest";

import { APP, AUTH, DOCS, GITHUB, LINKS, SALES } from "./links";

/**
 * The marketing site's outbound links are the funnel. A link that 404s costs more than a link that
 * doesn't exist, so these pin the two ways they rot:
 *   1. a typo'd host (docs.webhook.dev, app.webhook.io…) — caught here;
 *   2. a docs slug that was renamed — caught by the real-browser link check in the Playwright spec,
 *      which actually requests each one. jsdom can't tell a 200 from a 404.
 */

const flat = Object.values(LINKS).flatMap((v) =>
  typeof v === "string" ? [v] : Object.values(v as Record<string, string>),
);

describe("marketing links", () => {
  it("points every product link at a real webhook.co host", () => {
    expect(APP).toBe("https://app.webhook.co");
    expect(AUTH).toBe("https://auth.webhook.co");
    expect(DOCS).toBe("https://docs.webhook.co");
    expect(GITHUB).toBe("https://github.com/webhook-co");
  });

  it("uses the established sign-in destination (apps/web resolves the same one)", () => {
    expect(LINKS.signIn).toBe("https://auth.webhook.co/login");
  });

  // The changelog DOES exist — it's a Mintlify tab (apps/docs/changelog.mdx). It was a `#` only
  // because nobody had wired it.
  it("wires the changelog to the one that exists", () => {
    expect(LINKS.changelog).toBe("https://docs.webhook.co/changelog");
  });

  it("never ships an http:// or protocol-relative external link", () => {
    for (const href of flat) {
      if (href.startsWith("/") || href.startsWith("mailto:")) continue;
      expect(href, `${href} must be https`).toMatch(/^https:\/\//);
    }
  });

  // A double slash mid-path is always a template-literal bug (`${DOCS}//quickstart`). A trailing
  // slash on a *path* is a redirect hop; on a bare origin it's canonical, so it isn't flagged.
  it("has no malformed paths", () => {
    for (const href of flat) {
      if (href.startsWith("mailto:")) continue;
      expect(href, `${href} has a double slash`).not.toMatch(/[^:]\/\//);

      const path = href.startsWith("https://") ? new URL(href).pathname : href;
      if (path !== "/") expect(path, `${href} has a trailing slash`).not.toMatch(/\/$/);
    }
  });

  // There is no placeholder constant, on purpose. The site ships zero `href="#"` — a surface that
  // doesn't exist yet renders as TEXT, not as a link to nowhere — and `check-no-dead-links.mjs`
  // enforces that on the built HTML. A `PLACEHOLDER = "#"` export would be a loaded gun pointed at
  // that guard, so this pins that no link in the map is a bare `#`.
  it("holds no link to nowhere", () => {
    for (const href of [...flat, SALES]) {
      expect(href, "the links map must never carry a bare '#'").not.toBe("#");
    }
  });
});
