import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";

import PricingPage from "@/app/pricing/page";

import { axeComponent } from "@/test/axe";

import { BILLABLE_UNIT, BILLING_TERMS, Faq, FAQ_ITEMS } from "./faq";
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

  // The FAQ now starts FULLY COLLAPSED, and is an EXCLUSIVE accordion — opening one closes the rest.
  //
  // The must-disclose items used to be forced open here, because AGENTS.md requires the billing terms
  // be "disclosed up front on the pricing page". That promise did not go away: it moved to
  // <PricingDisclosure>, which is visible unconditionally and cannot be collapsed, and is guarded by
  // pricing-disclosure.test.tsx. Collapsing these WITHOUT moving it would have silently deleted a
  // constitutional disclosure — which is why that test exists and why this comment is here.
  it("starts fully collapsed — an accordion, not a wall of open panels", () => {
    const { container } = render(<Faq />);
    const details = [...container.querySelectorAll<HTMLDetailsElement>("details")];
    expect(details).toHaveLength(FAQ_ITEMS.length);
    expect(details.length).toBeGreaterThan(0); // non-vacuous
    expect(details.filter((d) => d.open)).toEqual([]);
  });

  it("is an EXCLUSIVE accordion — only one panel can be open at a time", () => {
    // Native `<details name=…>`: the browser enforces this, so it works before hydration and with JS
    // off. jsdom does not implement the exclusivity itself, so what's pinned here is the MECHANISM —
    // every panel shares one group name. Without it, they'd all open independently.
    const { container } = render(<Faq />);
    const names = [...container.querySelectorAll("details")].map((d) => d.getAttribute("name"));
    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size, "every panel must share one accordion group").toBe(1);
    expect(names[0]).toBeTruthy();
  });

  // The old CSS `faq-panel` keyframe only ever animated the panel OPEN — a native <details> hides its
  // children the instant `open` goes false, so a CSS accordion can fade in and can only snap shut.
  // motion now drives BOTH directions, which means JS owns `open` while the close plays out.
  //
  // Two things must survive that, and they are what these pin:
  //   1. the ANSWER TEXT is still server-rendered inside the <details>. It is FAQPage structured data
  //      and it is what a crawler (and a no-JS reader) sees. If the panels only mounted their content
  //      on open, the answers would vanish from the static export and the schema would describe a page
  //      that doesn't exist.
  //   2. the markup stays <details>/<summary> with a shared `name`, so before hydration — and with JS
  //      off — the accordion still opens, closes, and stays one-at-a-time. The animation is the
  //      enhancement; the behaviour is not.
  it("server-renders every answer inside its panel — crawlers and no-JS readers see them", () => {
    const { container } = render(<Faq />);
    const details = [...container.querySelectorAll<HTMLDetailsElement>("details")];
    expect(details.length).toBe(FAQ_ITEMS.length);

    for (const item of FAQ_ITEMS) {
      const panel = details.find((d) =>
        d.querySelector("summary")?.textContent?.includes(item.question),
      );
      expect(panel, `"${item.question}" is missing`).toBeTruthy();
      // Present in the DOM even though the panel is CLOSED — not mounted on demand.
      expect(panel!.textContent, `"${item.question}" does not render its answer`).toContain(
        item.answer.slice(0, 40),
      );
    }
  });

  it("keeps the native <details>/<summary> mechanics, so it works before hydration", () => {
    const { container } = render(<Faq />);
    for (const details of container.querySelectorAll("details")) {
      expect(details.querySelector("summary"), "a panel lost its <summary>").toBeTruthy();
      expect(details.getAttribute("name"), "a panel left the accordion group").toBeTruthy();
      expect(details.open, "no panel may be open on load").toBe(false);
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

// ── the billing disclosure ──────────────────────────────────────────────────────
// AGENTS.md names exactly ONE thing that must be disclosed up front on the pricing page: "the billable
// unit — every captured request to an endpoint". So that is the strict guard: it is the first FAQ, the
// first panel is open on load, and it must be readable without a click.
//
// The other billing terms are STATED on the page and carried in the FAQPage structured data, but sit
// one click away in the accordion. That is a deliberate founder decision (2026-07-12), taken over an
// earlier implementation that forced five panels open — so these assert PRESENCE, not openness. If the
// posture tightens again, BILLING_TERMS is the list to re-guard.
describe("the billing disclosure on /pricing", () => {
  beforeEach(() => {
    mockMatchMedia(true); // the Nav renders a ThemeToggle, which reads prefers-color-scheme
  });

  it("opens the BILLABLE UNIT on load — it must be readable without a click", () => {
    const { container } = render(<PricingPage />);
    const panels = [...container.querySelectorAll<HTMLDetailsElement>("details")];
    expect(panels.length).toBeGreaterThan(1);

    const open = panels.filter((d) => d.open);
    expect(open, "exactly one panel may be open on load").toHaveLength(1);
    expect(
      BILLABLE_UNIT.test(open[0]!.textContent ?? ""),
      "the open panel is not the billable unit — the constitution names THAT one specifically",
    ).toBe(true);
  });

  it("keeps the billable unit FIRST — reorder it and it stops being the one that opens", () => {
    expect(BILLABLE_UNIT.test(FAQ_ITEMS[0]!.answer)).toBe(true);
  });

  it("still STATES every other billing term, even though they sit behind a click", () => {
    const { container } = render(<PricingPage />);
    const text = container.textContent ?? "";
    expect(BILLING_TERMS.length).toBeGreaterThan(0); // non-vacuous
    for (const { what, needle } of BILLING_TERMS) {
      expect(needle.test(text), `the pricing page never states: ${what}`).toBe(true);
    }
  });

  it("carries every billing term into the FAQPage structured data", () => {
    // The schema is what an answer engine quotes. A term that exists only as collapsed markup, and not
    // in the JSON-LD, is a term we've stopped publishing.
    const { container } = render(<PricingPage />);
    const schema = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((n) => n.textContent ?? "")
      .join(" ");
    for (const { what, needle } of BILLING_TERMS) {
      expect(needle.test(schema), `the FAQPage schema omits: ${what}`).toBe(true);
    }
  });
});
