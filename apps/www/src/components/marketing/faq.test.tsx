import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { Faq, FAQ_ITEMS } from "./faq";
import { OVERAGE_PER_MILLION, TIERS } from "./pricing-tiers";

const answerFor = (match: RegExp): string =>
  FAQ_ITEMS.find((i) => match.test(i.question))?.answer ?? "";

const tier = (id: string) => TIERS.find((t) => t.id === id)!;

describe("FAQ", () => {
  it("renders every question as a disclosure the reader can open", () => {
    const { container } = render(<Faq />);
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(FAQ_ITEMS.length);
    for (const item of FAQ_ITEMS) {
      expect(screen.getByText(item.question)).toBeInTheDocument();
    }
  });

  // Native <details>/<summary>: keyboard operation, the expanded/collapsed state, and screen-reader
  // semantics all come from the platform. A div-with-onClick accordion would need `aria-expanded`,
  // `aria-controls`, key handling and a client boundary to get back to where the browser starts.
  it("uses native disclosure elements, so the semantics are not hand-rolled", () => {
    const { container } = render(<Faq />);
    for (const details of container.querySelectorAll("details")) {
      expect(details.querySelector("summary")).not.toBeNull();
    }
  });

  it("starts collapsed", () => {
    const { container } = render(<Faq />);
    for (const details of container.querySelectorAll<HTMLDetailsElement>("details")) {
      expect(details.open).toBe(false);
    }
  });

  it("exposes a linkable, labelled section", () => {
    render(<Faq />);
    const section = screen.getByRole("region", { name: /frequently asked/i });
    expect(section).toHaveAttribute("id", "faq");
  });

  it("states the real numbers", () => {
    render(<Faq />);
    expect(screen.getByText(/5,000 events/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(OVERAGE_PER_MILLION))).toBeInTheDocument();
  });
});

// ── drift guard ─────────────────────────────────────────────────────────────────
// These answers are billing promises, and they are ALSO published as machine-readable FAQPage
// JSON-LD that Google may surface as a rich result. So a number that quietly falls out of step with
// `pricing-tiers.ts` doesn't just make the copy wrong — it makes the page contradict itself (the tier
// card says one thing, the FAQ below says another) in a form search engines index.
//
// The retention windows and the free allowance read better as prose than as interpolations, so they
// are written out by hand. That is only safe because this block exists: change a tier and the test
// fails, naming this file.
describe("FAQ ↔ pricing-tiers drift", () => {
  it("quotes each tier's real retention window", () => {
    const answer = answerFor(/how long do you keep/i);
    // `TIERS[].retention` is itself pinned to what the engine enforces (PLAN_RETENTION_DAYS).
    for (const { retention } of TIERS) {
      const days = /(\d+)-day/.exec(retention)?.[1];
      if (!days) continue; // Enterprise is contractual ("up to 1 year"), not a day count.
      expect(
        answer,
        `the FAQ's retention answer no longer mentions "${days} days" — pricing-tiers.ts says "${retention}"`,
      ).toContain(`${days} days`);
    }
    expect(answer).toMatch(/year on Enterprise/i);
  });

  it("quotes the free plan's real one-time allowance", () => {
    const allowance = /^([\d,]+)/.exec(tier("free").includedEvents)?.[1];
    expect(allowance).toBeTruthy();
    expect(
      answerFor(/free allowance really one-time/i),
      `the FAQ no longer states the free allowance as "${allowance}"`,
    ).toContain(allowance!);
  });

  it("quotes the real overage price", () => {
    expect(answerFor(/past my included volume/i)).toContain(OVERAGE_PER_MILLION);
  });

  it("composes without axe violations", async () => {
    const { container } = render(<Faq />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});

describe("FAQ structured data", () => {
  // Google requires the markup to mirror the visible answer. If they diverge the page can be
  // penalised — so the schema is generated from the same array the DOM renders, not written twice.
  it("mirrors exactly the questions the page shows", () => {
    const { container } = render(<Faq />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();

    const schema = JSON.parse(script!.textContent!);
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.mainEntity).toHaveLength(FAQ_ITEMS.length);
    expect(schema.mainEntity.map((q: { name: string }) => q.name)).toEqual(
      FAQ_ITEMS.map((i) => i.question),
    );
    for (const entity of schema.mainEntity) {
      expect(entity["@type"]).toBe("Question");
      expect(entity.acceptedAnswer["@type"]).toBe("Answer");
      expect(entity.acceptedAnswer.text.length).toBeGreaterThan(0);
    }
  });
});
