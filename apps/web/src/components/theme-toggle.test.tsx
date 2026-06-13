import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "./theme-toggle";

/** jsdom doesn't implement matchMedia — stub it to a fixed system preference. */
function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the system preference on first visit (dark)", async () => {
    mockMatchMedia(true);
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the system preference on first visit (light)", async () => {
    mockMatchMedia(false);
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to dark theme/i }),
    ).toBeInTheDocument();
  });

  it("honors a stored 'dark' over a system light preference", async () => {
    mockMatchMedia(false);
    window.localStorage.setItem("wh-theme", "dark");
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("toggles, sets data-theme, and persists the choice", async () => {
    mockMatchMedia(false);
    render(<ThemeToggle />);
    const button = await screen.findByRole("button", { name: /switch to dark theme/i });
    await userEvent.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("wh-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });
});
