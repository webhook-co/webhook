import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import HomePage from "./page";

describe("HomePage", () => {
  // Render deterministically: reduced motion pauses the live stream (no interval) and resolves the
  // scroll reveals immediately, so the static tree is stable to assert against.
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the hero headline as the single h1", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /the webhook platform built for the agent era/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<HomePage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
  });

  it("renders every content section title as an h2", () => {
    render(<HomePage />);
    const titles = [
      /the same event, wherever you work/i,
      /received once, in order, never silently dropped/i,
      /every provider you add is a new way to fail silently/i,
      /private by default, open at the core/i,
      /point a webhook at it/i,
    ];
    for (const name of titles) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  // The feed is invented, so every name for it has to say so — including the ones only a screen
  // reader hears. Renaming the visible chip to "demo" while the accessible name still announced
  // "Live webhook inspector" would have left the fabricated stream presented as real to precisely
  // the users who cannot see the chip that corrects it.
  it("renders the demo inspector inside the hero, disclosed as a demo in its accessible name", () => {
    render(<HomePage />);
    const inspector = screen.getByRole("group", { name: /demo webhook inspector/i });
    expect(within(inspector).getByText(/1,284/)).toBeInTheDocument();
    expect(within(inspector).getByText(/sample webhook events/i)).toBeInTheDocument();
    expect(within(inspector).getByText(/not live measurements/i)).toBeInTheDocument();
  });

  it("renders the surfaces tablist with MCP selected by default", () => {
    render(<HomePage />);
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "CLI" })).toHaveAttribute("aria-selected", "false");
  });

  it("renders the Product nav dropdown collapsed by default (Developers was removed in the IA lane)", () => {
    render(<HomePage />);
    expect(screen.getByRole("button", { name: /^product$/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The Developers dropdown is gone — its docs deep-links live in the footer; the top nav carries a
    // single "Docs" link instead.
    expect(screen.queryByRole("button", { name: /^developers$/i })).toBeNull();
  });

  // Delivery SHIPPED — the engine, retries, signing and the DLQ are all live. The "soon" badge was
  // left over from before it did, and a stale "soon" on a feature that already works is worse than no
  // badge: it tells a visitor to come back later for something they could use right now.
  it("no longer marks delivery as 'soon' — it shipped", () => {
    render(<HomePage />);
    const delivery = screen.getByRole("region", {
      name: /received once, in order, never silently dropped/i,
    });
    expect(within(delivery).queryByText(/^soon$/i)).toBeNull();
  });

  it("renders the real Standard Webhooks link in the verification showcase", () => {
    render(<HomePage />);
    // Scoped to the verification ("provider tax") section — the footer and nav also link "Standard Webhooks".
    const verification = screen.getByRole("region", {
      name: /every provider you add is a new way to fail silently/i,
    });
    expect(within(verification).getByRole("link", { name: "Standard Webhooks" })).toHaveAttribute(
      "href",
      "https://www.standardwebhooks.com/",
    );
  });

  it("leads the hero with the sandbox — the one thing a stranger can do without an account", () => {
    // /play started life as a small text link under the CTAs: the least prominent element in the hero,
    // for the only thing on the page that needs no account. It now takes the hero's PRIMARY slot.
    // This pins prominence and ORDER, not just presence — a regression that demotes it back to prose,
    // or drops it behind the docs button, sails through a naive "is there a link to /play" check and
    // fails this one.
    render(<HomePage />);
    const cta = screen.getByRole("link", { name: /^open playground$/i });
    expect(cta).toHaveAttribute("href", "/play");
    // The design system's Button renders its own class; a plain prose link does not.
    expect(cta.className, "the sandbox CTA must be a button, not a text link").toMatch(/rounded/);

    // `Button asChild` renders the <a> itself, so its parent IS the CTA row.
    const row = cta.parentElement!;
    const buttons = [...row.querySelectorAll("a")].map((a) => a.textContent?.trim());
    expect(buttons).toEqual(["Open playground", "Read the docs"]);

    // No "Start free" in the hero: the nav's "Get started" is the same door on the same screen, and
    // two buttons to one destination is a decision the reader has to make for nothing.
    expect(buttons).not.toContain("Start free");

    // "Try it" read as an invitation to trial the whole platform — a promise the Free tier doesn't
    // make. The sandbox is named for what it is.
    expect(document.body.textContent ?? "").not.toMatch(/try it\s*—\s*no signup/i);
  });

  it("still closes the page with the sign-up CTA (dropping it from the hero must not lose it)", () => {
    render(<HomePage />);
    // The hero gave up "Start free"; the page must not have given up the conversion. The final CTA
    // and the nav both still carry a way in.
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /get started/i }).length).toBeGreaterThan(0);
  });

  it("renders the closing call to action", () => {
    render(<HomePage />);
    // "Start free" / "Read the docs" appear in both the hero and the final CTA — assert presence,
    // not an exact count, so the count rides on the hero regardless of the final CTA's button set.
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /read the docs/i }).length).toBeGreaterThan(0);
  });

  it("keeps the resource links discoverable in the footer (the Resources section was removed)", () => {
    render(<HomePage />);
    const developers = screen.getByRole("navigation", { name: /developers/i });
    expect(within(developers).getByRole("link", { name: /quickstart/i })).toBeInTheDocument();
    expect(within(developers).getByRole("link", { name: /api reference/i })).toBeInTheDocument();
  });

  // The full-page axe pass walks the whole marketing DOM (no violations — just more nodes), so this single
  // semantics scan gets a generous timeout.
  it("composes without axe violations (semantics — contrast is the real-browser job's)", async () => {
    const { container } = render(<HomePage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
