import { describe, expect, it } from "vitest";

import { pageMetadata, SITE_URL, siteMetadata, siteViewport } from "./metadata";

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

  it("defaults to dark (light still supported via the toggle)", () => {
    // The site defaults to dark; `dark light` tells the UA both are supported with dark preferred,
    // and the mobile browser-chrome tint matches the dark surface.
    expect(siteViewport.colorScheme).toBe("dark light");
    expect(siteViewport.themeColor).toBe("#0b0f14");
  });
});

// pageMetadata is the fix for the live "every inner page canonicalises to the homepage" bug: the
// root's alternates.canonical="/" was inherited by pricing/terms/privacy/dpa/... so Google saw them
// all as duplicates of /. A per-page helper makes the canonical AND og:url impossible to forget.
describe("pageMetadata (per-page canonical)", () => {
  it("sets a path-specific canonical, not the inherited root '/'", () => {
    expect(
      pageMetadata({ path: "/pricing", title: "Pricing", description: "d".repeat(80) }).alternates
        ?.canonical,
    ).toBe("/pricing");
  });

  it("sets og:url to the absolute page URL so it matches the canonical (the SEO gate's rule)", () => {
    const meta = pageMetadata({
      path: "/product/verification",
      title: "Verification",
      description: "d".repeat(80),
    });
    expect(meta.openGraph?.url).toBe(`${SITE_URL}/product/verification`);
  });

  it("keeps the full social card the root defines (does not drop images when overriding openGraph)", () => {
    const images = pageMetadata({ path: "/about", title: "About", description: "d".repeat(80) })
      .openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(first).toMatchObject({ url: "/og.png", width: 1200, height: 630 });
  });

  it("defaults og:type to website but honours an override", () => {
    expect(
      pageMetadata({ path: "/x", title: "X", description: "d".repeat(80) }).openGraph?.type,
    ).toBe("website");
    expect(
      pageMetadata({ path: "/y", title: "Y", description: "d".repeat(80), ogType: "article" })
        .openGraph?.type,
    ).toBe("article");
  });
});
