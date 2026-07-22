import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Mark } from "@webhook-co/ui";

import { DemoLockup, WindowChromeView } from "./components";

// The canonical mark's path data, extracted from the shared component itself —
// NOT a local copy. Pinning DemoLockup against this proves it renders the real
// brand mark; a literal here would only prove the copy matches itself.
const CANONICAL_MARK_PATHS = [
  ...renderToStaticMarkup(<Mark />).matchAll(/<path[^>]*\bd="([^"]+)"/g),
].map((m) => m[1]);

describe("WindowChromeView", () => {
  it("renders the three macOS traffic lights", () => {
    render(<WindowChromeView title="wbhk listen" />);
    expect(screen.getAllByTestId("traffic-light")).toHaveLength(3);
  });

  it("renders the window title verbatim", () => {
    render(<WindowChromeView title="wbhk listen" />);
    expect(screen.getByTestId("window-title").textContent).toBe("wbhk listen");
  });
});

describe("DemoLockup", () => {
  // The card built by an earlier pass used the generic Lucide "webhook" glyph in
  // green. The real mark is the shared `Mark` from @webhook-co/ui. DemoLockup now
  // imports it rather than re-drawing it, so a substitute brand mark cannot ship
  // silently — these assertions verify the rendered glyph IS the canonical one.
  it("has three arcs to pin against", () => {
    expect(CANONICAL_MARK_PATHS).toHaveLength(3);
  });

  it("draws the mark at the canonical stroke width, inheriting colour", () => {
    const { container } = render(<DemoLockup />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke-width")).toBe("3");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });

  it("renders exactly the canonical mark's paths", () => {
    const { container } = render(<DemoLockup />);
    const ds = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(ds).toEqual(CANONICAL_MARK_PATHS);
  });

  it("typesets the name lowercase, with .co de-emphasised", () => {
    render(<DemoLockup />);
    // Never "Webhook", never all-caps — and `.co` is a separate, muted element.
    expect(screen.getByTestId("lockup").textContent).toBe("webhook.co");
    expect(screen.getByTestId("lockup-tld").textContent).toBe(".co");
  });
});
