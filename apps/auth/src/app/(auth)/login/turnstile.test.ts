import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "./turnstile";

// resolveTheme picks the Turnstile widget theme to match the app's mode. The app toggles dark mode via a
// `data-theme` attribute on <html> (an in-app toggle persisted to localStorage), so we can't use Turnstile's
// `theme:"auto"` (that follows the OS only). resolveTheme reads the attribute and falls back to the OS
// preference when it's absent — mirroring the ThemeToggle's own fallback.

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

  it("falls back to the OS preference (dark) when no data-theme is set", () => {
    stubMatchMedia(true);
    expect(resolveTheme()).toBe("dark");
  });

  it("falls back to light when no data-theme is set and the OS prefers light", () => {
    stubMatchMedia(false);
    expect(resolveTheme()).toBe("light");
  });

  it("ignores an unrecognized data-theme value and falls back to the OS preference", () => {
    document.documentElement.setAttribute("data-theme", "sepia");
    stubMatchMedia(true);
    expect(resolveTheme()).toBe("dark");
  });

  it("defaults to light when neither data-theme nor matchMedia is available (SSR-safe)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveTheme()).toBe("light");
  });
});
