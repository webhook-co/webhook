import { describe, expect, it } from "vitest";
import { getRecipe } from "../index";
import { renderProviderPage, type CuratedSecret } from "./render";

// A fixture curated block — the real ones live in `curated.ts` and each cites the provider's own docs.
const fixture: CuratedSecret = {
  credentialName: "Signing secret",
  credentialKind: "secret",
  where:
    "In the dashboard, open Developers then Webhooks and reveal the endpoint's signing secret.",
  sourceUrl: "https://example.test/docs/webhooks",
};

const page = (slug: string, curated: CuratedSecret = fixture, name = "Example") =>
  renderProviderPage({ recipe: getRecipe(slug)!, displayName: name, icon: "plug", curated });

describe("renderProviderPage — the generated half cannot drift from the engine", () => {
  it("emits the frontmatter the docs nav guard requires (non-empty title + description)", () => {
    const mdx = page("mailgun", fixture, "Mailgun");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(mdx);
    expect(fm).not.toBeNull();
    expect(fm![1]).toMatch(/^title: ".+"$/m);
    expect(fm![1]).toMatch(/^description: ".+"$/m);
    expect(fm![1]).toMatch(/^sidebarTitle: "Mailgun"$/m);
  });

  it("states the provider's real signature header, taken from the recipe", () => {
    const r = getRecipe("zendesk")!;
    expect(r.signatureHeader).toBeTruthy();
    expect(page("zendesk", fixture, "Zendesk")).toContain(r.signatureHeader!);
  });

  it("calls an asymmetric provider's credential a public key, never a signing secret", () => {
    // Discord registers Discord's Ed25519 PUBLIC key. Calling it a "signing secret" would be a lie
    // about what the operator pastes — and would teach the wrong mental model.
    const curated: CuratedSecret = {
      credentialName: "Public Key",
      credentialKind: "public-key",
      where: "Open the application in the developer portal and copy its public key.",
      sourceUrl: "https://example.test/docs/discord",
    };
    const mdx = page("discord", curated, "Discord");
    expect(mdx).toContain("Public Key");
    expect(mdx.toLowerCase()).not.toContain("signing secret");
  });

  it("links the provider's own documentation as the source for the curated step", () => {
    expect(page("mailgun", fixture, "Mailgun")).toContain("https://example.test/docs/webhooks");
  });

  it("reports the replay window only when the engine actually enforces one", () => {
    const enforced = getRecipe("zendesk")!;
    const notEnforced = getRecipe("mailgun")!;
    // Whichever way each provider falls, the page must agree with `replayWindow.enforced`.
    for (const [slug, r] of [
      ["zendesk", enforced],
      ["mailgun", notEnforced],
    ] as const) {
      const mdx = page(slug, fixture, "Example");
      if (r.replayWindow.enforced) {
        expect(mdx).toMatch(/replay/i);
        expect(mdx).toContain(String(r.replayWindow.toleranceSeconds));
      } else {
        expect(mdx).not.toMatch(/enforces a .*replay window/i);
      }
    }
  });

  it("is deterministic — the same inputs render byte-identical output", () => {
    expect(page("sendgrid", fixture, "SendGrid")).toBe(page("sendgrid", fixture, "SendGrid"));
  });

  it("refuses to render without a cited source (fail closed, no uncited dashboard prose)", () => {
    const uncited = { ...fixture, sourceUrl: "" };
    expect(() => page("mailgun", uncited, "Mailgun")).toThrow(/source/i);
  });

  it("carries no forbidden marketing claim phrasing", () => {
    const mdx = page("contentful", fixture, "Contentful").toLowerCase();
    for (const banned of [
      "guaranteed delivery",
      "never lose an event",
      "100% uptime",
      "trusted by",
    ]) {
      expect(mdx).not.toContain(banned);
    }
  });
});
