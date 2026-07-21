import { describe, expect, it } from "vitest";
import { mdxToText, manifestEntry } from "./manifest";

describe("mdxToText — what the dup-guard actually compares", () => {
  it("drops frontmatter, so titles and descriptions don't pad the word count", () => {
    const out = mdxToText(
      `---\ntitle: "Verify X webhooks"\ndescription: "Some description here"\n---\n\nReal prose.\n`,
    );
    expect(out).toContain("Real prose");
    expect(out).not.toContain("Verify X webhooks");
    expect(out).not.toContain("Some description here");
  });

  it("drops fenced code blocks — they are identical boilerplate across providers", () => {
    // Including them would make every page look MORE similar to every other, inverting the guard.
    const out = mdxToText(
      "Before.\n\n```sh\nwbhk events list <endpoint-id> --status verified\n```\n\nAfter.",
    );
    expect(out).toContain("Before");
    expect(out).toContain("After");
    expect(out).not.toContain("wbhk events list");
  });

  it("drops JSX/MDX component tags but keeps the prose inside them", () => {
    const out = mdxToText("<CodeGroup>\n\nKeep this sentence.\n\n</CodeGroup>");
    expect(out).toContain("Keep this sentence");
    expect(out).not.toContain("CodeGroup");
  });

  it("keeps heading and inline-code TEXT (it is real, visible, provider-specific content)", () => {
    const out = mdxToText("## Get the signing secret\n\nThe `x-foo-signature` header carries it.");
    expect(out).toContain("Get the signing secret");
    expect(out).toContain("x-foo-signature");
    expect(out).not.toContain("##");
    expect(out).not.toContain("`");
  });

  it("keeps link text but drops the URL (a URL is not prose)", () => {
    const out = mdxToText("See [the official docs](https://example.test/a/b) for steps.");
    expect(out).toContain("the official docs");
    expect(out).not.toContain("example.test");
  });
});

describe("manifestEntry — the shape the guard requires", () => {
  it("carries the id/host/path/name/header the neutralizer needs", () => {
    const e = manifestEntry({
      slug: "mailgun",
      displayName: "Mailgun",
      signatureHeader: "x-mailgun-signature",
      mdx: "---\ntitle: t\n---\n\nMailgun signs the body.",
    });
    expect(e.id).toBe("docs:mailgun");
    expect(e.host).toBe("docs");
    expect(e.path).toBe("/providers/mailgun");
    expect(e.intent).toBe("reference");
    expect(e.name).toBe("Mailgun");
    expect(e.header).toBe("x-mailgun-signature");
    expect(e.text).toContain("signs the body");
  });

  it("tolerates a provider with no signature header (sig-in-body schemes)", () => {
    const e = manifestEntry({
      slug: "adyen",
      displayName: "Adyen",
      signatureHeader: null,
      mdx: "Body.",
    });
    expect(e.header).toBe("");
  });
});
