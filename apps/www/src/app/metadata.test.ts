import { describe, expect, it } from "vitest";

import { SITE_URL, siteMetadata, siteViewport } from "./metadata";

// Fast, build-free assertions over the metadata *object*. The rendered-HTML truth (and the soft
// length warnings) live in scripts/check-seo-html.mjs, which runs against out/ after a build.
describe("site metadata", () => {
  it("canonicalizes every URL to the www host", () => {
    expect(SITE_URL).toBe("https://www.webhook.co");
    expect(siteMetadata.metadataBase?.toString()).toBe("https://www.webhook.co/");
    expect(siteMetadata.alternates?.canonical).toBe("/");
    expect(siteMetadata.openGraph?.url).toBe(SITE_URL);
  });

  it("ships a complete social card (the summary_large_image / no-image bug fix)", () => {
    expect(siteMetadata.twitter?.card).toBe("summary_large_image");
    const images = siteMetadata.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(first).toMatchObject({ url: "/og.png", width: 1200, height: 630 });
    expect(first).toHaveProperty("alt");
    expect(siteMetadata.twitter?.images).toContain("/og.png");
  });

  it("is configured to be indexed (never accidentally noindex)", () => {
    expect(siteMetadata.robots).toMatchObject({ index: true, follow: true });
  });

  it("declares a title template and a non-empty description", () => {
    expect(siteMetadata.title).toMatchObject({
      template: expect.stringContaining("webhook.co"),
    });
    expect(typeof siteMetadata.description).toBe("string");
    expect((siteMetadata.description as string).length).toBeGreaterThan(0);
  });

  it("is a light-only site", () => {
    expect(siteViewport.colorScheme).toBe("light");
  });
});
