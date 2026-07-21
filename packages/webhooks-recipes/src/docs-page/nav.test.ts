import { describe, expect, it } from "vitest";
import { withProviderPages } from "./nav";

const docsJson = () => ({
  $schema: "https://mintlify.com/docs.json",
  seo: { organization: { name: "webhook.co" } },
  navigation: {
    tabs: [
      {
        tab: "Guides",
        groups: [
          { group: "Providers", icon: "plug", pages: ["providers/directory", "providers/stripe"] },
        ],
      },
      { tab: "Help", groups: [{ group: "Help", pages: ["help/index"] }] },
    ],
  },
});

describe("withProviderPages — nav wiring the docs-nav guard demands", () => {
  it("adds each generated page to the Providers group", () => {
    const out = withProviderPages(docsJson(), ["mailgun", "zendesk"]);
    const pages = out.navigation.tabs[0].groups[0].pages;
    expect(pages).toContain("providers/mailgun");
    expect(pages).toContain("providers/zendesk");
  });

  it("keeps the existing hand-written pages (a generator must not evict curated work)", () => {
    const pages = withProviderPages(docsJson(), ["mailgun"]).navigation.tabs[0].groups[0].pages;
    expect(pages).toContain("providers/directory");
    expect(pages).toContain("providers/stripe");
  });

  it("is idempotent — regenerating does not duplicate an entry", () => {
    const once = withProviderPages(docsJson(), ["mailgun"]);
    const twice = withProviderPages(once, ["mailgun"]);
    const pages = twice.navigation.tabs[0].groups[0].pages;
    expect(pages.filter((p: string) => p === "providers/mailgun")).toHaveLength(1);
  });

  it("leaves every other tab, group, and the pinned seo block untouched", () => {
    const before = docsJson();
    const after = withProviderPages(before, ["mailgun"]);
    expect(after.seo).toEqual(before.seo); // byte-pinned by docs-structured-data-guard
    expect(after.navigation.tabs[1]).toEqual(before.navigation.tabs[1]);
  });

  it("throws when the Providers group is absent rather than silently writing nothing", () => {
    const noGroup = {
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "Help", pages: [] }] }] },
    };
    expect(() => withProviderPages(noGroup, ["mailgun"])).toThrow(/Providers/);
  });
});
