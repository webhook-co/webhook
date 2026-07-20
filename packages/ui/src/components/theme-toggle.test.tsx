import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle, themeInitScript } from "./theme-toggle";

/**
 * jsdom doesn't implement matchMedia. We stub it to a fixed OS preference and use it as a REGRESSION
 * GUARD: the product default is dark regardless of the OS, so a test that pins the OS to *light* and
 * still expects *dark* proves we ignore `prefers-color-scheme`. If anyone re-introduces an OS fallback,
 * these expectations flip and the test fails.
 */
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

  it("defaults to dark on first visit, even when the OS prefers light", async () => {
    mockMatchMedia(false); // OS says light — must be ignored
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("defaults to dark on first visit when the OS prefers dark", async () => {
    mockMatchMedia(true);
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("honors a stored 'light' over the dark default (even when the OS prefers dark)", async () => {
    mockMatchMedia(true);
    window.localStorage.setItem("wh-theme", "light");
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to dark theme/i }),
    ).toBeInTheDocument();
  });

  it("honors a stored 'dark'", async () => {
    mockMatchMedia(false);
    window.localStorage.setItem("wh-theme", "dark");
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("resolves an unrecognized stored value to the dark default (never applies it verbatim)", async () => {
    // Only "light"/"dark" are ever written; a garbage value (tampering/format drift) must not leak
    // onto <html data-theme>, and must resolve to the default like the init script does.
    window.localStorage.setItem("wh-theme", "Dark");
    document.documentElement.removeAttribute("data-theme");
    render(<ThemeToggle />);
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("toggles, sets data-theme, and persists the choice", async () => {
    // Seed a stored 'light' so the starting point is deterministic regardless of the default.
    window.localStorage.setItem("wh-theme", "light");
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
   * to the CSS default while the button said otherwise. State was right, the DOM was not.
   *
   * The absent attribute here is what hydration leaves behind. Mounting must RE-APPLY it, not merely
   * remember it. In a browser that race is timing-sensitive (it hid on a fast machine and only failed
   * on slow CI); asserting the mount contract directly is what makes it deterministic.
   */
  it("re-applies data-theme on mount when the attribute is missing (post-hydration)", async () => {
    window.localStorage.setItem("wh-theme", "dark");
    document.documentElement.removeAttribute("data-theme");

    render(<ThemeToggle />);

    // Not just the label — the DOM attribute the whole stylesheet keys off.
    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies the DARK default on mount when nothing is stored, regardless of the OS", async () => {
    mockMatchMedia(false); // OS says light — the default must still be dark
    window.localStorage.removeItem("wh-theme");
    document.documentElement.removeAttribute("data-theme");

    render(<ThemeToggle />);

    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

/**
 * The pre-paint inline script is the first thing that decides the theme — before React exists — so it
 * is what actually delivers the dark default (and prevents a light flash). Exercise the shipped string
 * directly so it can never silently drift from the component's own resolution.
 */
describe("themeInitScript (pre-paint default)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runInitScript() {
    // Execute the exact shipped inline script (an IIFE string) so the pre-paint default is under test.
    new Function(themeInitScript)();
  }

  it("stamps data-theme=dark when nothing is stored, ignoring the OS preference", () => {
    mockMatchMedia(false); // OS says light
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stamps a stored 'light' preference", () => {
    mockMatchMedia(true); // OS says dark — the stored choice must still win
    window.localStorage.setItem("wh-theme", "light");
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stamps a stored 'dark' preference", () => {
    window.localStorage.setItem("wh-theme", "dark");
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("normalizes an unrecognized stored value to dark", () => {
    window.localStorage.setItem("wh-theme", "Dark"); // not a valid value → default
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
