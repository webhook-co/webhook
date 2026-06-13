import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DesignSystemPage from "./page";

// notFound() throws in real Next (to halt rendering) — mirror that so the guard is observable.
const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

// Strip motion-only props so the mocked motion.div renders as a clean DOM div.
vi.mock("motion/react", () => ({ useReducedMotion: () => false }));
vi.mock("motion/react-client", async () => {
  const React = await import("react");
  const Div = ({
    children,
    initial: _i,
    animate: _a,
    transition: _t,
    variants: _v,
    ...rest
  }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement("div", rest, children);
  return { div: Div };
});

describe("DesignSystemPage — dev-only route guard", () => {
  beforeEach(() => {
    // ThemeToggle reads matchMedia in an effect; jsdom doesn't implement it.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    notFoundMock.mockClear();
  });

  it("renders the showcase in development (never calls notFound)", () => {
    // NODE_ENV is "test" here, so isProduction is false — the dev path.
    render(<DesignSystemPage />);
    expect(screen.getByText("One ink, four signals, zero accents.")).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("emits a 404 (calls notFound) in a production build", async () => {
    // isProduction is captured at module load, so stub the env and re-import. The guard is
    // the first statement, so notFound() throws before any JSX is constructed.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { default: ProdPage } = await import("./page");
    expect(() => ProdPage()).toThrow();
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});
