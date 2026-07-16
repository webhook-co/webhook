import { describe, expect, it } from "vitest";

import { renderBrandedEmail } from "./email-shell";

const BASE = {
  subject: "A subject",
  heading: "A heading",
  preview: "A preview",
  paragraphs: ["First para.", "Second para."],
  footer: "A footer",
};

describe("renderBrandedEmail", () => {
  it("carries the subject through unchanged", () => {
    expect(renderBrandedEmail(BASE).subject).toBe("A subject");
  });

  it("renders the heading, paragraphs and footer into the HTML", () => {
    const { html } = renderBrandedEmail(BASE);
    expect(html).toContain("A heading");
    expect(html).toContain("First para.");
    expect(html).toContain("Second para.");
    expect(html).toContain("A footer");
  });

  it("renders the preheader in a hidden block so it previews but doesn't display", () => {
    const { html } = renderBrandedEmail(BASE);
    expect(html).toMatch(/<div style="display:none;[^"]*">A preview<\/div>/);
  });

  it("renders the logo image alongside a text wordmark, so it degrades when images are blocked", () => {
    const { html } = renderBrandedEmail(BASE);
    expect(html).toContain('src="https://www.webhook.co/logo.png"');
    expect(html).toContain('alt="webhook.co"');
    // The wordmark is real text, not part of the image — blocked images still leave the brand readable.
    expect(html).toContain(">webhook</span>");
    expect(html).toContain(">.co</span>");
  });

  // Every caller-supplied string is untrusted (org names, key names, inviter addresses are user-chosen).
  describe("escaping", () => {
    it("escapes the heading", () => {
      const { html } = renderBrandedEmail({ ...BASE, heading: "<script>alert(1)</script>" });
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes paragraphs", () => {
      const { html } = renderBrandedEmail({ ...BASE, paragraphs: ["<img onerror=x>"] });
      expect(html).not.toContain("<img onerror=x>");
      expect(html).toContain("&lt;img onerror=x&gt;");
    });

    it("escapes the preview, footer and subject", () => {
      const { html } = renderBrandedEmail({
        ...BASE,
        subject: "<b>s</b>",
        preview: "<b>p</b>",
        footer: "<b>f</b>",
      });
      expect(html).not.toContain("<b>s</b>");
      expect(html).not.toContain("<b>p</b>");
      expect(html).not.toContain("<b>f</b>");
    });

    it("escapes the CTA label and URL", () => {
      const { html } = renderBrandedEmail({
        ...BASE,
        cta: { label: "<b>go</b>", url: 'https://x.test/"onmouseover="alert(1)' },
      });
      expect(html).not.toContain("<b>go</b>");
      expect(html).not.toContain('"onmouseover="alert(1)');
      expect(html).toContain("&quot;onmouseover=&quot;");
    });

    it("escapes the code", () => {
      const { html } = renderBrandedEmail({ ...BASE, code: "<b>123</b>" });
      expect(html).not.toContain("<b>123</b>");
    });
  });

  describe("CTA", () => {
    it("renders a dark branded button when a CTA is given", () => {
      const { html } = renderBrandedEmail({
        ...BASE,
        cta: { label: "Sign in", url: "https://app.webhook.co/x" },
      });
      expect(html).toContain('href="https://app.webhook.co/x"');
      expect(html).toContain("Sign in");
      expect(html).toContain("background-color:#18181b");
    });

    it("omits the button entirely when no CTA is given", () => {
      const { html } = renderBrandedEmail(BASE);
      expect(html).not.toContain("background-color:#18181b");
      expect(html).not.toContain("<a href=");
    });

    it("renders the copy-paste fallback URL only when a fallback note is given", () => {
      const withNote = renderBrandedEmail({
        ...BASE,
        cta: { label: "Sign in", url: "https://app.webhook.co/x", fallbackNote: "Button broken?" },
      }).html;
      expect(withNote).toContain("Button broken?");
      // The raw URL must appear as selectable text, not only inside the button's href.
      expect(withNote.match(/https:\/\/app\.webhook\.co\/x/g)?.length).toBeGreaterThan(1);

      const withoutNote = renderBrandedEmail({
        ...BASE,
        cta: { label: "Sign in", url: "https://app.webhook.co/x" },
      }).html;
      expect(withoutNote).not.toContain("Button broken?");
      expect(withoutNote.match(/https:\/\/app\.webhook\.co\/x/g)?.length).toBe(1);
    });
  });

  describe("code block", () => {
    it("renders the code prominently when given", () => {
      const { html } = renderBrandedEmail({ ...BASE, code: "418290" });
      expect(html).toContain("418290");
      // Pin the code's OWN tracking, not just any letter-spacing — the wordmark has one too, so a bare
      // "letter-spacing" assertion would pass even with the code block missing entirely.
      expect(html).toContain("letter-spacing:6px");
    });

    it("omits the code block when not given", () => {
      const { html } = renderBrandedEmail(BASE);
      expect(html).not.toContain("letter-spacing:6px");
    });
  });

  describe("plain-text alternative", () => {
    it("includes the heading, paragraphs and footer", () => {
      const { text } = renderBrandedEmail(BASE);
      expect(text).toContain("A heading");
      expect(text).toContain("First para.");
      expect(text).toContain("Second para.");
      expect(text).toContain("A footer");
    });

    it("includes the CTA as a label and a raw URL", () => {
      const { text } = renderBrandedEmail({
        ...BASE,
        cta: { label: "Sign in", url: "https://app.webhook.co/x" },
      });
      expect(text).toContain("Sign in: https://app.webhook.co/x");
    });

    it("omits the CTA line when there is no CTA", () => {
      const { text } = renderBrandedEmail(BASE);
      expect(text).not.toContain("undefined");
      expect(text.trim().endsWith("A footer")).toBe(true);
    });

    it("includes the code", () => {
      const { text } = renderBrandedEmail({ ...BASE, code: "418290" });
      expect(text).toContain("418290");
    });

    it("never carries HTML escaping into the text part", () => {
      const { text } = renderBrandedEmail({ ...BASE, heading: "Tom & Jerry" });
      expect(text).toContain("Tom & Jerry");
      expect(text).not.toContain("&amp;");
    });
  });
});
