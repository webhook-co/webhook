import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import CaptureReplayPage, { metadata as captureMeta } from "./capture-replay/page";
import DeliveryPage, { metadata as deliveryMeta } from "./delivery/page";
import AgentTriggersPage, { metadata as agentTriggersMeta } from "./agent-triggers/page";
import VerificationPage, { metadata as verificationMeta } from "./verification/page";

// One test file for the four /product/* pages: they share the ProductShell, so they share these
// invariants. The honesty guard is the point — these pages state shipped capabilities, so a
// regression that reintroduced a compliance claim we don't hold, or the "blocks until" MCP framing
// that's factually wrong, must turn a test red rather than ship.

const PAGES = [
  {
    name: "Capture & replay",
    Page: CaptureReplayPage,
    meta: captureMeta,
    h1: /replay it to localhost/i,
  },
  {
    name: "Verification",
    Page: VerificationPage,
    meta: verificationMeta,
    h1: /signature fails, you.ll know why/i,
  },
  { name: "Delivery", Page: DeliveryPage, meta: deliveryMeta, h1: /never silently dropped/i },
  {
    name: "Agent triggers",
    Page: AgentTriggersPage,
    meta: agentTriggersMeta,
    h1: /an event they can act on/i,
  },
] as const;

// Claims no product page may make — the truth-debt this whole lane removes. Regex, case-insensitive.
const FORBIDDEN: RegExp[] = [
  /SOC 2/i,
  /HIPAA/i,
  /SAML/i,
  /\bfree,? (and )?permanent\b/i, // the wedge the pricing can't back
  /blocks? until/i, // false MCP push framing
  /real-time/i,
  /zero[- ]knowledge/i,
];

describe("product pages", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { name, Page, meta, h1 } of PAGES) {
    describe(name, () => {
      it("renders exactly one h1, matching its headline", () => {
        render(<Page />);
        expect(screen.getByRole("heading", { level: 1, name: h1 })).toBeInTheDocument();
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      });

      it("has a main landmark wired to the skip link", () => {
        render(<Page />);
        expect(screen.getByRole("main")).toHaveAttribute("id", "main");
        expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute(
          "href",
          "#main",
        );
      });

      it("has at least two feature sections as h2s", () => {
        render(<Page />);
        expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(2);
      });

      it("leads with one primary CTA (Get started)", () => {
        render(<Page />);
        expect(screen.getAllByRole("link", { name: /get started/i }).length).toBeGreaterThanOrEqual(
          1,
        );
      });

      it("makes no claim we can't back (compliance / push / free-permanent)", () => {
        const { container } = render(<Page />);
        const text = container.textContent ?? "";
        for (const pattern of FORBIDDEN) {
          expect(text, `"${name}" contains a forbidden claim matching ${pattern}`).not.toMatch(
            pattern,
          );
        }
      });

      // The meta description + title are the SERP/social snippet — a surface that renders standalone,
      // WITHOUT the page body's qualifiers, and that render(<Page/>) never mounts. An overclaim here
      // (e.g. "142 verified", "SOC 2 compliant") is exactly where a regression hides, so scan it too.
      it("makes no forbidden claim in its meta title/description either", () => {
        const snippet = `${String(meta.title ?? "")} ${String(meta.description ?? "")}`;
        for (const pattern of FORBIDDEN) {
          expect(
            snippet,
            `"${name}" meta contains a forbidden claim matching ${pattern}`,
          ).not.toMatch(pattern);
        }
      });

      it("has no accessibility violations", async () => {
        const { container } = render(<Page />);
        expect(await axeComponent(container)).toHaveNoViolations();
      });
    });
  }
});
