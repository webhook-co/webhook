import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Mark } from "@webhook-co/ui";

import {
  SOCIALCARD_HEIGHT,
  SOCIALCARD_WIDTH,
  SocialCard,
  SOCIAL_HEADLINE,
  SOCIAL_SUBLINE,
} from "./SocialCard";

const CANONICAL_MARK_PATHS = [
  ...renderToStaticMarkup(<Mark />).matchAll(/<path[^>]*\bd="([^"]+)"/g),
].map((m) => m[1]);

describe("SocialCard geometry", () => {
  it("is GitHub's recommended 1280×640 (2:1)", () => {
    expect(SOCIALCARD_WIDTH).toBe(1280);
    expect(SOCIALCARD_HEIGHT).toBe(640);
    expect(SOCIALCARD_WIDTH / SOCIALCARD_HEIGHT).toBe(2);
  });
});

describe("SocialCard copy", () => {
  it("leads with the wedge, names no competitor, and is not the rejected tagline", () => {
    const all = `${SOCIAL_HEADLINE} ${SOCIAL_SUBLINE}`.toLowerCase();
    // The founder rejected "the webhook platform built for the agent era".
    expect(all).not.toContain("agent era");
    // Repo content must never name a competitor.
    for (const banned of ["ngrok", "webhook.site", "svix", "hookdeck", "requestbin", "beeceptor"]) {
      expect(all).not.toContain(banned);
    }
    // The wedge is permanence — stated as a contrast, not a slogan.
    expect(SOCIAL_HEADLINE.toLowerCase()).toContain("expire");
  });

  it("renders both the headline and subline text", () => {
    const { container } = render(<SocialCard />);
    const text = container.textContent ?? "";
    // Headline and subline are split across styled spans; compare ignoring whitespace.
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain(SOCIAL_HEADLINE.replace(/\s+/g, " "));
    expect(flat).toContain(SOCIAL_SUBLINE.replace(/\s+/g, " "));
  });
});

describe("SocialCard brand mark", () => {
  it("uses the canonical Mark, not a substitute glyph", () => {
    const { container } = render(<SocialCard />);
    const ds = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    for (const d of CANONICAL_MARK_PATHS) {
      expect(ds).toContain(d);
    }
  });
});
