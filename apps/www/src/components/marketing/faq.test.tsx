import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { Faq, FAQ_ITEMS } from "./faq";

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

  // The FAQ answers are billing promises. If they drift from the tier data they stop being true, so
  // the numbers are interpolated from the same module the cards render from — never retyped.
  it("states the real numbers, taken from the pricing source of truth", () => {
    render(<Faq />);
    expect(screen.getByText(/5,000 events/)).toBeInTheDocument();
    expect(screen.getByText(/€25/)).toBeInTheDocument();
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
