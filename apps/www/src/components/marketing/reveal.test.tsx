import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installIntersectionObserverMock, mockMatchMedia } from "@/lib/test-utils";
import { Reveal } from "./reveal";

function setInnerHeight(value: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value });
}

describe("Reveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setInnerHeight(768);
  });

  it("arms the hidden state below the fold, then reveals on intersect", () => {
    mockMatchMedia(false);
    const io = installIntersectionObserverMock();
    setInnerHeight(0); // rect.top (0) >= innerHeight (0) → below the fold
    render(
      <Reveal>
        <p>Reveal me</p>
      </Reveal>,
    );
    const wrapper = screen.getByText("Reveal me").parentElement;
    expect(screen.getByText("Reveal me")).toBeInTheDocument();
    expect(wrapper).toHaveClass("reveal-hidden");
    expect(io.instances).toBe(1);

    act(() => io.triggerIntersect());
    expect(wrapper).toHaveClass("reveal-in");
    expect(wrapper).not.toHaveClass("reveal-hidden");
  });

  it("reveals immediately and never observes when already in view", () => {
    mockMatchMedia(false);
    const io = installIntersectionObserverMock();
    setInnerHeight(768); // rect.top (0) < innerHeight → in view
    render(
      <Reveal>
        <p>In view</p>
      </Reveal>,
    );
    const wrapper = screen.getByText("In view").parentElement;
    expect(wrapper).not.toHaveClass("reveal-hidden");
    expect(io.instances).toBe(0);
  });

  it("reveals immediately under reduced motion and never constructs an observer", () => {
    mockMatchMedia(true);
    const io = installIntersectionObserverMock();
    setInnerHeight(0);
    render(
      <Reveal>
        <p>Reduced</p>
      </Reveal>,
    );
    const wrapper = screen.getByText("Reduced").parentElement;
    expect(wrapper).not.toHaveClass("reveal-hidden");
    expect(io.instances).toBe(0);
  });

  it("keeps content visible when IntersectionObserver is unavailable", () => {
    mockMatchMedia(false);
    setInnerHeight(0); // would arm, but no observer support → reveal immediately
    render(
      <Reveal>
        <p>No IO</p>
      </Reveal>,
    );
    const wrapper = screen.getByText("No IO").parentElement;
    expect(wrapper).not.toHaveClass("reveal-hidden");
  });
});
