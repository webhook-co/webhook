import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import { Inspector } from "./inspector";

describe("Inspector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders as a labeled group with the seed rows and counter at rest (reduced motion → paused)", () => {
    mockMatchMedia(true); // paused: no interval, deterministic seed
    render(<Inspector />);
    expect(screen.getByRole("group", { name: /live webhook inspector/i })).toBeInTheDocument();
    // No heading: the hero's h1 is the page's only heading; the inspector is labeled by its group.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
    // SEED_COUNTER (1284) rendered via toLocaleString → "1,284".
    expect(screen.getByText(/1,284/)).toBeInTheDocument();
    // The seed carries both a verified and a failed event so the static frame shows both.
    expect(screen.getAllByText(/verified/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/timestamp too old/i)).toBeInTheDocument();
  });

  it("starts paused under reduced motion and offers Play", () => {
    mockMatchMedia(true);
    render(<Inspector />);
    expect(screen.getByRole("button", { name: /play the event stream/i })).toBeInTheDocument();
  });

  it("toggles the pause/play control by flipping its accessible label", async () => {
    mockMatchMedia(false); // playing
    render(<Inspector />);
    await userEvent.click(screen.getByRole("button", { name: /pause the event stream/i }));
    expect(screen.getByRole("button", { name: /play the event stream/i })).toBeInTheDocument();
  });

  it("treats Replay as a real button with a real local result", async () => {
    mockMatchMedia(true); // paused so rows don't shift mid-test
    render(<Inspector />);
    const replays = screen.getAllByRole("button", { name: /^replay /i });
    expect(replays.length).toBeGreaterThan(0);
    await userEvent.click(replays[0]);
    expect(screen.getByText(/replayed 1/i)).toBeInTheDocument();
  });

  it("marks the moving list aria-live off to avoid screen-reader spam", () => {
    mockMatchMedia(true);
    const { container } = render(<Inspector />);
    expect(container.querySelector("ul")).toHaveAttribute("aria-live", "off");
  });

  it("has no axe violations", async () => {
    mockMatchMedia(true); // paused → deterministic seed frame
    const { container } = render(<Inspector />);
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
