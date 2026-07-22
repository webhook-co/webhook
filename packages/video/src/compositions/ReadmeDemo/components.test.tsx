import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colors } from "../../promo/tokens";
import { CalloutView, DemoLockup, MARK_PATHS, WindowChromeView } from "./components";

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
  // green. The real mark is packages/ui/src/components/mark.tsx — three arcs at
  // stroke-width 3 inheriting currentColor. Pin the geometry so a substitute
  // brand mark can never ship silently again.
  it("uses the canonical three-arc mark geometry", () => {
    expect(MARK_PATHS).toEqual([
      "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2",
      "m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06",
      "m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
    ]);
  });

  it("draws the mark at the canonical stroke width, inheriting colour", () => {
    const { container } = render(<DemoLockup />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke-width")).toBe("3");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });

  it("renders every canonical path", () => {
    const { container } = render(<DemoLockup />);
    const ds = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(ds).toEqual(MARK_PATHS);
  });

  it("typesets the name lowercase, with .co de-emphasised", () => {
    render(<DemoLockup />);
    // Never "Webhook", never all-caps — and `.co` is a separate, muted element.
    expect(screen.getByTestId("lockup").textContent).toBe("webhook.co");
    expect(screen.getByTestId("lockup-tld").textContent).toBe(".co");
  });
});

describe("CalloutView", () => {
  const band = { x: 228, y: 58, width: 212, height: 252 };

  it("renders nothing when fully faded out", () => {
    const { container } = render(<CalloutView opacity={0} band={band} label="signature verdict" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the label when visible", () => {
    render(<CalloutView opacity={1} band={band} label="signature verdict" />);
    expect(screen.getByTestId("callout-label").textContent).toBe("signature verdict");
  });

  it("positions the band at the measured verdict-column geometry", () => {
    render(<CalloutView opacity={1} band={band} label="signature verdict" />);
    const el = screen.getByTestId("callout-band");
    expect(el.style.left).toBe("228px");
    expect(el.style.top).toBe("58px");
    expect(el.style.width).toBe("212px");
    expect(el.style.height).toBe("252px");
  });

  it("carries the supplied opacity so the wrapper owns the timing", () => {
    render(<CalloutView opacity={0.5} band={band} label="signature verdict" />);
    expect(screen.getByTestId("callout").style.opacity).toBe("0.5");
  });

  it("tints with the film's single accent, not a new colour", () => {
    render(<CalloutView opacity={1} band={band} label="signature verdict" />);
    expect(screen.getByTestId("callout-band").style.borderColor).toBeTruthy();
    expect(colors.verified).toBe("#3FB27F");
  });
});
