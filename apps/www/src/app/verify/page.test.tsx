import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIENT_VERIFIABLE_RECIPES, RECIPES } from "@webhook-co/webhooks-recipes";

import { axeComponent } from "@/test/axe";
import { installIntersectionObserverMock, mockMatchMedia } from "@/lib/test-utils";

import VerifyPage, { metadata } from "./page";

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

  // ── The provider count this page claims ──────────────────────────────────────────────────────
  //
  // The page used to hardcode "120+ providers" in BOTH the meta description and the lede. That was
  // honest when it was written and is still not false, but it is unpinned prose about a number the
  // registry owns, which is the exact shape of every count-drift defect this repo has already had.
  //
  // 🔑 The number here is NOT the registry size. The registry is 144 providers; the browser tool can
  // only offer the ones whose key is not fetched from the provider's own servers, because a page
  // cannot make that request. That subset is `CLIENT_VERIFIABLE_RECIPES` and it is smaller. Claiming
  // the registry count on this page would be claiming the tool does something it cannot do, so these
  // tests pin the SUBSET and separately prove the two counts have not silently become the same
  // number — if they ever do, the "left out" sentence below is a lie and must go.
  describe("the provider count it claims", () => {
    it("states the client-verifiable count, derived, in the lede", () => {
      const { container } = renderVerify();
      expect(container.textContent).toContain(`${CLIENT_VERIFIABLE_RECIPES.length} providers`);
    });

    it("states the same derived count in the meta description", () => {
      expect(metadata.description).toContain(`${CLIENT_VERIFIABLE_RECIPES.length} providers`);
    });

    // Without this, the two assertions above would still pass if someone reintroduced a literal that
    // happened to match today's count. Any bare "NNN providers" on the page must BE the derived one.
    it("carries no provider count other than the derived one", () => {
      const { container } = renderVerify();
      const claimed = [
        ...(container.textContent ?? "").matchAll(/(\d[\d,+]*)\+?\s+providers/gi),
      ].map((m) => m[1].replace(/[,+]/g, ""));
      expect(
        claimed.length,
        "the page must state its provider count at least once",
      ).toBeGreaterThan(0);
      for (const n of claimed) {
        expect(Number(n), `"${n} providers" is not the client-verifiable count`).toBe(
          CLIENT_VERIFIABLE_RECIPES.length,
        );
      }
    });

    // The page tells the reader that remote-key providers "are left out". That sentence is only true
    // while the subset is a PROPER subset. If every recipe became client-verifiable the copy would be
    // wrong, and no count assertion above would notice.
    it("only claims providers are left out while some actually are", () => {
      const { container } = renderVerify();
      const saysLeftOut = /left out|can(?:no|')t be checked/i.test(container.textContent ?? "");
      expect(
        saysLeftOut,
        "copy claims providers are excluded, but every recipe is client-verifiable",
      ).toBe(CLIENT_VERIFIABLE_RECIPES.length < RECIPES.length);
    });
  });

  it("composes without axe violations", async () => {
    const { container } = renderVerify();
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 30000);
});
