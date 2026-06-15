import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { InspectorStage } from "./inspector-stage";

describe("InspectorStage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the seed rows and counter at rest (reduced motion → paused)", () => {
    mockMatchMedia(true); // paused: no interval, deterministic seed
    render(<InspectorStage />);
    expect(
      screen.getByRole("heading", { level: 2, name: /every webhook, the moment it lands/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
    // SEED_COUNTER (1284) rendered via toLocaleString → "1,284".
    expect(screen.getByText(/1,284/)).toBeInTheDocument();
    // The seed carries both a verified and a failed event so the static frame shows both.
    expect(screen.getAllByText(/verified/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/timestamp too old/i)).toBeInTheDocument();
  });

  it("starts paused under reduced motion and offers Play", () => {
    mockMatchMedia(true);
    render(<InspectorStage />);
    expect(screen.getByRole("button", { name: /play the event stream/i })).toBeInTheDocument();
  });

  it("toggles the pause/play control by flipping its accessible label", async () => {
    mockMatchMedia(false); // playing
    render(<InspectorStage />);
    await userEvent.click(screen.getByRole("button", { name: /pause the event stream/i }));
    expect(screen.getByRole("button", { name: /play the event stream/i })).toBeInTheDocument();
  });

  it("treats Replay as a real button with a real local result", async () => {
    mockMatchMedia(true); // paused so rows don't shift mid-test
    render(<InspectorStage />);
    const replays = screen.getAllByRole("button", { name: /^replay /i });
    expect(replays.length).toBeGreaterThan(0);
    await userEvent.click(replays[0]);
    expect(screen.getByText(/replayed 1/i)).toBeInTheDocument();
  });

  it("marks the moving list aria-live off to avoid screen-reader spam", () => {
    mockMatchMedia(true);
    const { container } = render(<InspectorStage />);
    expect(container.querySelector("ul")).toHaveAttribute("aria-live", "off");
  });
});
