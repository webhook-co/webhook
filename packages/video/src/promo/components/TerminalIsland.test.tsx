import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { colors, shadows } from "../tokens";
import { TerminalIslandView } from "./TerminalIsland";

// TerminalIslandView is the pure presentational half of the adapter: it takes the
// already-computed entrance progress as a prop instead of reading Remotion's
// useCurrentFrame(), so it renders like any other React component — no Remotion
// composition context required (same split as BrandLockupView / HeadlineSceneView).
describe("TerminalIslandView", () => {
  it("renders exactly three faux traffic-light dots regardless of header", () => {
    render(
      <TerminalIslandView width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    expect(screen.getAllByTestId("terminal-island-dot")).toHaveLength(3);
  });

  it("renders the traffic-light dots monochrome (term-border), never a saturated color", () => {
    // Accent discipline (brief §3.1): green is the only saturated accent in the film
    // except the S7 mutation and S9 legend. The header chrome must never spend it.
    render(
      <TerminalIslandView width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    const dots = screen.getAllByTestId("terminal-island-dot");
    for (const dot of dots) {
      expect((dot as HTMLElement).style.backgroundColor).toBe(hexToRgb(colors.termBorder));
    }
  });

  it("omits the header title node when no header is passed", () => {
    render(
      <TerminalIslandView width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    expect(screen.queryByTestId("terminal-island-title")).toBeNull();
  });

  it("renders the header title verbatim when passed", () => {
    render(
      <TerminalIslandView header="mcp.webhook.co" width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    expect(screen.getByTestId("terminal-island-title").textContent).toBe("mcp.webhook.co");
  });

  it("renders children inside the mono body", () => {
    render(
      <TerminalIslandView width={800} progress={1}>
        <span data-testid="probe">2026-07-12T14:02:11.840Z linear verified</span>
      </TerminalIslandView>,
    );
    expect(screen.getByTestId("probe").textContent).toBe(
      "2026-07-12T14:02:11.840Z linear verified",
    );
  });

  it("defaults raised to true: term-bg-2 surface + the brief's exact drop shadow", () => {
    render(
      <TerminalIslandView width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    const surface = screen.getByTestId("terminal-island-surface") as HTMLElement;
    const outer = screen.getByTestId("terminal-island") as HTMLElement;
    expect(surface.style.backgroundColor).toBe(hexToRgb(colors.termBg2));
    expect(outer.style.boxShadow).toBe(shadows.terminal);
  });

  it("flattens to a shadow-less term-bg backdrop when raised is false", () => {
    render(
      <TerminalIslandView width={800} raised={false} progress={1}>
        body
      </TerminalIslandView>,
    );
    const surface = screen.getByTestId("terminal-island-surface") as HTMLElement;
    const outer = screen.getByTestId("terminal-island") as HTMLElement;
    expect(surface.style.backgroundColor).toBe(hexToRgb(colors.termBg));
    expect(outer.style.boxShadow).toBe("none");
  });

  it("holds the panel fully hidden and offset at progress 0", () => {
    render(
      <TerminalIslandView width={800} progress={0}>
        body
      </TerminalIslandView>,
    );
    const outer = screen.getByTestId("terminal-island") as HTMLElement;
    expect(outer.style.opacity).toBe("0");
    expect(outer.style.transform).toBe("translateY(16px) scale(0.97)");
  });

  it("settles to fully visible and untransformed at progress 1", () => {
    render(
      <TerminalIslandView width={800} progress={1}>
        body
      </TerminalIslandView>,
    );
    const outer = screen.getByTestId("terminal-island") as HTMLElement;
    expect(outer.style.opacity).toBe("1");
    expect(outer.style.transform).toBe("translateY(0px) scale(1)");
  });

  it("clamps past progress 1 instead of overshooting (no bounce on the container)", () => {
    // progress=1.5 is out of the interpolate() input range [0, 1]. Without
    // extrapolateRight: "clamp" this would extrapolate past the settled state.
    render(
      <TerminalIslandView width={800} progress={1.5}>
        body
      </TerminalIslandView>,
    );
    const outer = screen.getByTestId("terminal-island") as HTMLElement;
    expect(outer.style.opacity).toBe("1");
    expect(outer.style.transform).toBe("translateY(0px) scale(1)");
  });

  it("applies the requested panel width", () => {
    render(
      <TerminalIslandView width={640} progress={1}>
        body
      </TerminalIslandView>,
    );
    expect((screen.getByTestId("terminal-island") as HTMLElement).style.width).toBe("640px");
  });
});

/** jsdom serializes inline `backgroundColor: "#RRGGBB"` styles back out as `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
