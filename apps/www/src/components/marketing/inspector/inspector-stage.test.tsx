import { render, screen, within } from "@testing-library/react";
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
    // "github" now appears in the stream row AND in the surfaces companion for the selected event.
    expect(screen.getAllByText("github").length).toBeGreaterThan(0);
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

  it("follows the newest event by default, with no pin pressed", () => {
    mockMatchMedia(true);
    render(<InspectorStage />);
    // Nothing is pinned: the surfaces simply follow the newest (verified github) event.
    expect(
      screen.getByRole("button", { name: /inspect github push across surfaces/i }),
    ).toHaveAttribute("aria-pressed", "false");
    const group = screen.getByRole("group", { name: /across all four surfaces/i });
    expect(within(group).getAllByText("github").length).toBeGreaterThan(0);
    expect(within(group).queryByText(/timestamp too old/i)).not.toBeInTheDocument();
  });

  it("toggles a pin: click selects an event, click again returns to following the newest", async () => {
    mockMatchMedia(true); // paused so rows don't shift mid-test
    render(<InspectorStage />);
    const shopifyPin = screen.getByRole("button", {
      name: /inspect shopify orders\.create across surfaces/i,
    });
    const group = () => screen.getByRole("group", { name: /across all four surfaces/i });

    expect(shopifyPin).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(shopifyPin);
    expect(shopifyPin).toHaveAttribute("aria-pressed", "true");
    expect(within(group()).getAllByText(/timestamp too old/i).length).toBeGreaterThan(0);

    // Click again → un-pin → back to following the newest (verified github) event.
    await userEvent.click(shopifyPin);
    expect(shopifyPin).toHaveAttribute("aria-pressed", "false");
    expect(within(group()).queryByText(/timestamp too old/i)).not.toBeInTheDocument();
  });
});
