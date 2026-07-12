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

    // toggling back returns to light (covers the dark→light path)
    await userEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("wh-theme")).toBe("light");
  });
  /**
   * REGRESSION. The pre-paint script stamps `data-theme` on <html> before React exists; React then
   * hydrates that same element and can drop an attribute it never rendered. When that happened, this
   * component still knew the right theme — it just never wrote it back, so the page silently fell back
   * to light while the button said "dark". State was right, the DOM was not.
   *
   * The absent attribute here is what hydration leaves behind. Mounting must RE-APPLY it, not merely
   * remember it. In a browser that race is timing-sensitive (it hid on a fast machine and only failed
   * on slow CI); asserting the mount contract directly is what makes it deterministic.
   */
  it("re-applies data-theme on mount when the attribute is missing (post-hydration)", async () => {
    mockMatchMedia(false);
    window.localStorage.setItem("wh-theme", "dark");
    document.documentElement.removeAttribute("data-theme");

    render(<ThemeToggle />);

    // Not just the label — the DOM attribute the whole stylesheet keys off.
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-applies the SYSTEM theme on mount when nothing is stored", async () => {
    mockMatchMedia(true); // OS says dark
    window.localStorage.removeItem("wh-theme");
    document.documentElement.removeAttribute("data-theme");

    render(<ThemeToggle />);

    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
