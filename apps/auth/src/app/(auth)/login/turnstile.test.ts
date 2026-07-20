import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "./turnstile";

// resolveTheme picks the Turnstile widget theme to match the app's mode. The app toggles dark mode via a
// `data-theme` attribute on <html> (an in-app toggle persisted to localStorage), so we can't use Turnstile's
// `theme:"auto"` (that follows the OS only). resolveTheme reads the attribute and, when it's absent, falls
// back to the product default — dark — mirroring the ThemeToggle's own dark default, not the OS.
// `stubMatchMedia` stays a regression guard: pin the OS to light and still expect dark ⇒ the OS is ignored.

function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: prefersDark && query.includes("dark"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("resolveTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("returns the explicit data-theme when set to dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("returns the explicit data-theme when set to light", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(resolveTheme()).toBe("light");
  });

  it("falls back to dark when no data-theme is set, even if the OS prefers light", () => {
    stubMatchMedia(false); // OS light — must be ignored; the product default is dark
    expect(resolveTheme()).toBe("dark");
  });

  it("falls back to dark when no data-theme is set and the OS prefers dark", () => {
    stubMatchMedia(true);
    expect(resolveTheme()).toBe("dark");
  });

  it("ignores an unrecognized data-theme value and falls back to dark", () => {
    document.documentElement.setAttribute("data-theme", "sepia");
    stubMatchMedia(false);
    expect(resolveTheme()).toBe("dark");
  });

  it("defaults to dark when no data-theme is set (SSR-safe, no matchMedia)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveTheme()).toBe("dark");
  });
});
