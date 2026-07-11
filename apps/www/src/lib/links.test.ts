import { describe, expect, it } from "vitest";

import { APP, AUTH, DOCS, GITHUB, LINKS, PLACEHOLDER } from "./links";

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
      if (href.startsWith("/") || href.startsWith("mailto:") || href === PLACEHOLDER) continue;
      expect(href, `${href} must be https`).toMatch(/^https:\/\//);
    }
  });

  // A double slash mid-path is always a template-literal bug (`${DOCS}//quickstart`). A trailing
  // slash on a *path* is a redirect hop; on a bare origin it's canonical, so it isn't flagged.
  it("has no malformed paths", () => {
    for (const href of flat) {
      if (href === PLACEHOLDER || href.startsWith("mailto:")) continue;
      expect(href, `${href} has a double slash`).not.toMatch(/[^:]\/\//);

      const path = href.startsWith("https://") ? new URL(href).pathname : href;
      if (path !== "/") expect(path, `${href} has a trailing slash`).not.toMatch(/\/$/);
    }
  });

  // `PLACEHOLDER` is the deliberate, named "#" for the surfaces that genuinely do not exist yet
  // (About, Blog, the socials, a status page, a roadmap). Naming it means a reviewer can tell an
  // *intentional* gap from a link someone simply forgot to wire.
  it("names its placeholders instead of scattering bare '#'", () => {
    expect(PLACEHOLDER).toBe("#");
  });
});
