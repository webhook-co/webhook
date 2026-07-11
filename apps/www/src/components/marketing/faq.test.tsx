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

  // The MUST-disclose items are OPEN; everything else starts collapsed. This is the whole compliance
  // mechanism, so it's asserted as a shape, not a vibe: exactly the `discloses` items are open.
  it("opens exactly the MUST-disclose items and collapses the rest", () => {
    const { container } = render(<Faq />);
    const details = [...container.querySelectorAll<HTMLDetailsElement>("details")];
    expect(details).toHaveLength(FAQ_ITEMS.length);

    const openQuestions = details
      .filter((d) => d.open)
      .map((d) => d.querySelector("summary")?.textContent?.trim());
    const shouldBeOpen = FAQ_ITEMS.filter((i) => i.discloses).map((i) => i.question);

    expect(openQuestions).toEqual(shouldBeOpen);
    expect(shouldBeOpen.length).toBeGreaterThan(0);
  });

  // `faq-panel` is the fade-in-from-opacity-0 animation. A MUST-disclose panel is open on page load,
  // so carrying that class would mean the disclosure starts TRANSPARENT — which is exactly the bug
  // this whole model exists to avoid. Motion belongs only on panels a reader chooses to open.
  it("never animates a MUST-disclose panel in from transparent", () => {
    const { container } = render(<Faq />);
    for (const details of container.querySelectorAll<HTMLDetailsElement>("details")) {
      const panel = details.querySelector("div");
      const question = details.querySelector("summary")?.textContent?.trim();
      const disclosed = FAQ_ITEMS.find((i) => i.question === question)?.discloses;

      if (disclosed) {
        expect(panel?.className, `"${question}" would fade in from opacity 0`).not.toContain(
          "faq-panel",
        );
      } else {
        expect(panel?.className, `"${question}" lost its open animation`).toContain("faq-panel");
      }
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

// ── the MUST-disclose set ───────────────────────────────────────────────────────
// Moved here verbatim-in-spirit from `pricing.test.tsx` when <PricingDisclosures> was deleted. It is
// the same tripwire, pointed at the FAQ, because the obligation didn't go away when the component did.
//
// AGENTS.md requires pricing be "disclosed UP FRONT … on the pricing page", and ADR-0104 leans on the
// pricing page as the disclosure of record for a billing-INCREASING default. So it is not enough for
// the text to be in the DOM — a collapsed <details> would put it there while showing the reader
// nothing. Each fact below is asserted AND asserted visible.
describe("FAQ — the MUST-disclose set", () => {
  const answerOf = (match: RegExp) => FAQ_ITEMS.find((i) => match.test(i.question));

  /** The <details> that contains this text, so we can assert the reader can actually see it. */
  const disclosureFor = (container: HTMLElement, needle: RegExp) =>
    [...container.querySelectorAll<HTMLDetailsElement>("details")].find((d) =>
      needle.test(d.textContent ?? ""),
    );

  it("says a delivery is a billed event (Definition B) — and shows it without a click", () => {
    const { container } = render(<Faq />);
    expect(screen.getByText(/a delivery to a destination is one event/i)).toBeInTheDocument();
    expect(screen.getByText(/that's four events/i)).toBeInTheDocument();
    expect(disclosureFor(container, /a delivery to a destination is one event/i)?.open).toBe(true);
  });

  it("discloses that CANCELLING lands you paused — ADR-0004 marks this MUST-disclose", () => {
    const { container } = render(<Faq />);
    expect(screen.getByText(/capture pauses until you resubscribe/i)).toBeInTheDocument();
    expect(screen.getByText(/never resets/i)).toBeInTheDocument();
    expect(disclosureFor(container, /capture pauses until you resubscribe/i)?.open).toBe(true);
  });

  it("discloses the dedup=off trade — and shows it without a click", () => {
    const { container } = render(<Faq />);
    expect(
      screen.getByText(/every retry a provider sends is a distinct captured request/i),
    ).toBeInTheDocument();
    expect(
      disclosureFor(container, /every retry a provider sends is a distinct captured request/i)
        ?.open,
    ).toBe(true);
  });

  // Present, but not required to be open: "retries are free" is good news, and the disclosure rule
  // exists to surface the SURPRISES. (jsdom models <details> visibility correctly, which is what makes
  // the `.open` assertions above meaningful rather than decorative — so this distinction is real.)
  it("says retries are never billed", () => {
    render(<Faq />);
    expect(
      screen.getByText(/a delivery is billed once, when we first dispatch it/i),
    ).toBeInTheDocument();
  });

  // Both of these were being billed as full deliveries until migration 0055
  // (`delivery_attempts.billable`). If someone re-bills either leg, this is the test that says the
  // page is now lying about the bill.
  //
  // Asserted against the RENDERED DOM, not against `FAQ_ITEMS`. Reading the data array back proves
  // only that the string exists in the module — it would stay green if `FaqEntry` stopped rendering
  // `answer` at all, or if the item were dropped from the list. The obligation is about what reaches
  // the page, so the test has to look at the page.
  it("says forwarding to your own machine is free — we make no outbound request", () => {
    const { container } = render(<Faq />);
    expect(screen.getByText(/forwarding to your own machine/i)).toBeInTheDocument();
    expect(screen.getByText(/your CLI makes that request, not us/i)).toBeInTheDocument();
    expect(disclosureFor(container, /forwarding to your own machine/i)?.open).toBe(true);
  });

  it("says a delivery we REFUSE to send is not billed", () => {
    const { container } = render(<Faq />);
    expect(screen.getByText(/a delivery we refuse to send/i)).toBeInTheDocument();
    expect(disclosureFor(container, /a delivery we refuse to send/i)?.open).toBe(true);
  });

  // `answer` is rendered as plain text into a <p> and serialised into the FAQPage JSON-LD. Markdown
  // is never parsed, so a backtick or a ** here renders literally on the page AND gets published to
  // Google as part of the rich result. Shipped exactly that (`` `wbhk listen` ``) once.
  it("never smuggles markdown into an answer", () => {
    for (const { question, answer } of FAQ_ITEMS) {
      expect(answer, `"${question}" contains a backtick — answers are plain text`).not.toMatch(/`/);
      expect(answer, `"${question}" contains markdown emphasis`).not.toMatch(/\*\*|__/);
    }
  });

  it("says capture PAUSES at the limit rather than billing", () => {
    render(<Faq />);
    expect(screen.getByText(/capture pauses\./i)).toBeInTheDocument();
  });

  it("states the dedup default as a full sentence (no swallowed space)", () => {
    // The old JSX version rendered "default.If you" because JSX drops a leading space after a closing
    // tag. The answers are plain strings now, so that class of bug is structurally impossible — but
    // the SENTENCE still has to be there.
    const answer = answerOf(/deduplication off cost more/i)?.answer ?? "";
    expect(answer).toContain("Deduplication is on by default. If you turn it off");
    expect(answer).not.toContain("default.If");
  });
});

describe("public-repo content hygiene", () => {
  it("never names a competitor", () => {
    const { container } = render(<Faq />);
    const text = container.textContent ?? "";
    for (const name of ["Svix", "Hookdeck", "Zapier", "Convoy", "ngrok"]) {
      expect(text).not.toContain(name);
    }
  });

  it('never claims "unlimited"', () => {
    const { container } = render(<Faq />);
    expect(container.textContent ?? "").not.toMatch(/unlimited/i);
  });
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
