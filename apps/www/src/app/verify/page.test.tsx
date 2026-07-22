import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { axeComponent } from "@/test/axe";
import { installIntersectionObserverMock, mockMatchMedia } from "@/lib/test-utils";

import VerifyPage from "./page";

function renderVerify() {
  mockMatchMedia(true);
  installIntersectionObserverMock();
  return render(<VerifyPage />);
}

afterEach(() => vi.unstubAllGlobals());

describe("/verify", () => {
  it("renders exactly one h1", () => {
    renderVerify();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("renders the signature verifier tool", () => {
    renderVerify();
    expect(screen.getByRole("form", { name: /webhook signature verifier/i })).toBeTruthy();
  });

  // The tool is the format that ranks for these terms — every result for "webhook tester" is an
  // instant tool, so the FAQ substance goes strictly BENEATH it. A reader must reach the verifier
  // before any prose. jsdom cannot see layout (the phone above-the-fold invariant is pinned in
  // Playwright), but it CAN see source order: the tool must precede the FAQ in the document.
  it("keeps the tool ahead of the FAQ in document order", () => {
    const { container } = renderVerify();
    const tool = screen.getByRole("form", { name: /webhook signature verifier/i });
    const faq = container.querySelector("#faq");
    expect(faq, "the verify page must carry an FAQ").not.toBeNull();
    expect(
      tool.compareDocumentPosition(faq!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the FAQ must come AFTER the tool, never above it",
    ).toBeTruthy();
  });

  it("emits FAQPage JSON-LD built from the questions it renders", () => {
    const { container } = renderVerify();
    const faqLd = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent!.replace(/\\u003c/g, "<")))
      .find((j) => j["@type"] === "FAQPage");
    expect(faqLd, "the page must publish FAQPage JSON-LD").toBeDefined();
    const questions = faqLd.mainEntity.map((q: { name: string }) => q.name).join(" | ");
    // The substance the signature-verification SERP rewards is troubleshooting, not a definition:
    // the raw-body pitfall is the single most common cause of a signature that will not match.
    expect(questions, "the FAQ must answer why a signature fails to match").toMatch(
      /signature.*(match|fail)|raw (request )?body/i,
    );
    // Answers are plain text (they double-serialize into the schema); no markup may leak in.
    for (const q of faqLd.mainEntity) {
      expect(q.acceptedAnswer.text, "markup in a verify FAQ answer").not.toMatch(
        /[*`#<>]|\[.*\]\(/,
      );
    }
  });

  it("composes without axe violations", async () => {
    const { container } = renderVerify();
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 30000);
});
