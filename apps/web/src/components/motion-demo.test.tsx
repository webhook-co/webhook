import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factories (hoisted above imports) can see this fn.
const { reduceMock } = vi.hoisted(() => ({ reduceMock: vi.fn<() => boolean>() }));

vi.mock("motion/react", () => ({ useReducedMotion: () => reduceMock() }));

// Render motion.div as a plain div that surfaces the two motion props this component
// drives off reduced-motion (`initial` and `transition.staggerChildren`) as data-attrs,
// so we can assert the behavior without a real animation runtime.
vi.mock("motion/react-client", async () => {
  const React = await import("react");
  const Div = ({
    children,
    initial,
    transition,
    animate: _animate,
    variants: _variants,
    ...rest
  }: {
    children?: React.ReactNode;
    initial?: unknown;
    transition?: { staggerChildren?: number };
    animate?: unknown;
    variants?: unknown;
  }) =>
    React.createElement(
      "div",
      { ...rest, "data-initial": String(initial), "data-stagger": transition?.staggerChildren },
      children,
    );
  return { div: Div };
});

import { MotionDemo } from "./motion-demo";

describe("MotionDemo", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders every pipeline step and a replay control", () => {
    reduceMock.mockReturnValue(false);
    render(<MotionDemo />);
    expect(screen.getByText("received")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("→ agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replay/i })).toBeInTheDocument();
  });

  it("staggers the reveal when reduced-motion is off", () => {
    reduceMock.mockReturnValue(false);
    const { container } = render(<MotionDemo />);
    const stage = container.querySelector("[data-stagger]");
    expect(stage?.getAttribute("data-stagger")).toBe("0.12");
    expect(stage?.getAttribute("data-initial")).toBe("hidden");
  });

  it("resolves instantly (no stagger, initial false) under reduced motion", () => {
    reduceMock.mockReturnValue(true);
    const { container } = render(<MotionDemo />);
    const stage = container.querySelector("[data-stagger]");
    expect(stage?.getAttribute("data-stagger")).toBe("0");
    expect(stage?.getAttribute("data-initial")).toBe("false");
  });

  it("re-runs the reveal when Replay is clicked", async () => {
    reduceMock.mockReturnValue(false);
    render(<MotionDemo />);
    await userEvent.click(screen.getByRole("button", { name: /replay/i }));
    expect(screen.getByText("received")).toBeInTheDocument();
  });
});
