"use client";

import * as React from "react";

import { IconButton } from "./icon-button";

type Theme = "light" | "dark";

const STORAGE_KEY = "wh-theme";

/** The product default: dark, brand-first, independent of the OS `prefers-color-scheme`. */
const DEFAULT_THEME: Theme = "dark";

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Light/dark switch shown across every surface (marketing site and in-app). The product defaults
 * to dark on first visit — a deliberate brand-first choice, independent of the OS preference — and
 * this toggle lets anyone switch to light. The choice is persisted under `wh-theme` and always wins
 * on return. Icon-only — a moon in light mode, a sun in dark. Pair it with {@link themeInitScript}
 * in the document head so the dark default (or a saved preference) never flashes the other theme
 * before hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>(DEFAULT_THEME);

  React.useEffect(() => {
    // Any value other than an explicit "light" resolves to the default — mirroring themeInitScript, so
    // the pre-paint stamp and this mount resolution never disagree (even on a garbage stored value).
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const resolved: Theme = stored === "light" ? "light" : DEFAULT_THEME;
    setTheme(resolved);
    // RE-APPLY, don't just remember. The pre-paint script stamps `data-theme` on <html> before React
    // exists; React then hydrates the <html> element and can drop an attribute it never rendered. When
    // that happened the page fell back to light while this button still said "dark" — the state was
    // right and the DOM was not. Writing it again on mount makes the theme self-healing, and is a
    // no-op when the attribute survived. (It surfaced as a CI-only failure: the race is timing
    // -sensitive, so it hid on a fast machine and showed up on a slow one.)
    applyTheme(resolved);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  const isDark = theme === "dark";

  return (
    <IconButton
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </IconButton>
  );
}

/**
 * Inline, render-blocking script that stamps `data-theme` before paint, so the dark default (or a
 * saved `wh-theme` preference) never flashes the other theme first. With nothing stored it defaults
 * to dark, independent of the OS `prefers-color-scheme`; only an explicit stored `"light"` opts out.
 * Inject it in the document head via `dangerouslySetInnerHTML`.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}catch(e){}})();`;
