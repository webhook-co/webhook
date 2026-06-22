"use client";

import * as React from "react";

import { TURNSTILE_ACTION, TURNSTILE_SITEKEY } from "@/runtime/urls";

import type { CaptchaWidgetProps } from "./login-form";

// The Cloudflare Turnstile widget for the magic-link form. Explicit render (not the implicit auto-render)
// so the solved-token callback is a closure, not a global — the React-friendly path. The script is loaded
// once per document, lazily inside the effect (never at module load), so importing this file is side-effect
// free and the login-form tests can inject a fake captcha without Cloudflare's script touching jsdom.
//
// Presentation (to sit alongside the email field): `size: "flexible"` makes the widget fill its container
// width — matching the field's `w-full` responsiveness — down to Turnstile's 300px PLATFORM floor (it won't
// render narrower). The form column (max-w-[366px], fluid below that) stays ≥300px down to a ~344px-wide
// viewport; only on a legacy ~320px phone does the column dip under the floor (founder eyeball). The widget
// keeps its native corners (clipping to the field's radius looked off — founder call); and the theme tracks
// the app's light/dark mode (a `data-theme` attribute on <html>, not the OS), re-rendering on an in-app flip.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileTheme = "light" | "dark";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      size?: "normal" | "flexible" | "compact";
      theme?: TurnstileTheme | "auto";
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * The widget theme to match the app's current mode. The app toggles dark mode with a `data-theme` attribute
 * on <html> (an in-app toggle persisted to localStorage), so Turnstile's `theme:"auto"` — which only follows
 * the OS — would drift from a user who toggled. Read the attribute; fall back to the OS preference when it's
 * absent (mirroring the ThemeToggle's own fallback).
 */
export function resolveTheme(): TurnstileTheme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

let scriptPromise: Promise<void> | null = null;

/** Load Cloudflare's Turnstile script once; subsequent callers await the same promise. */
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      scriptPromise = null; // allow a retry on the next mount
      reject(new Error("failed to load the Turnstile script"));
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Renders the Turnstile challenge and reports the solved token via `onToken` (and `onToken(null)` when it
 * expires, errors, or the script fails to load — so the form's submit stays gated). Single-use is handled
 * by the form remounting this component (a changing `key`) to get a fresh token after a failed send.
 */
export function Turnstile({ onToken }: CaptchaWidgetProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let widgetId: string | undefined;
    let renderedTheme: TurnstileTheme | undefined;
    let cancelled = false;

    const renderWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      renderedTheme = resolveTheme();
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITEKEY,
        action: TURNSTILE_ACTION,
        // Flexible → fills the container width (down to Turnstile's 300px floor), matching the field.
        size: "flexible",
        theme: renderedTheme,
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };

    loadTurnstileScript()
      .then(renderWidget)
      .catch((error) => {
        // Fails the gate closed (submit stays disabled), but a script/CDN outage blocks ALL logins, so
        // surface it — otherwise it presents as "the send button never enables" with no signal.
        console.warn(
          "turnstile load/render failed",
          error instanceof Error ? error.message : error,
        );
        onToken(null);
      });

    // Track the in-app light/dark toggle: Turnstile has no live theme-update API, so re-render when the
    // <html> data-theme flips (this resets the single-use token → onToken(null), then the fresh widget
    // re-solves — an acceptable cost for the rare mid-login toggle).
    const observer = new MutationObserver(() => {
      if (cancelled || widgetId === undefined || !window.turnstile) return;
      if (resolveTheme() === renderedTheme) return;
      window.turnstile.remove(widgetId);
      widgetId = undefined;
      onToken(null);
      renderWidget();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken]);

  // Full-width to match the email field; the widget keeps its own native corners (no radius clip).
  // data-action is an informational marker (the turnstile-spin-v1 activation tag) — the auto-render path
  // would read it; explicit render takes the action from render() above.
  return <div ref={containerRef} className="w-full cf-turnstile" data-action={TURNSTILE_ACTION} />;
}
