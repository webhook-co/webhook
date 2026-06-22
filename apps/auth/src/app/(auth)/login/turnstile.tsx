"use client";

import * as React from "react";

import { TURNSTILE_ACTION, TURNSTILE_SITEKEY } from "@/runtime/urls";

import type { CaptchaWidgetProps } from "./login-form";

// The Cloudflare Turnstile widget for the magic-link form. Explicit render (not the implicit auto-render)
// so the solved-token callback is a closure, not a global — the React-friendly path. The script is loaded
// once per document, lazily inside the effect (never at module load), so importing this file is side-effect
// free and the login-form tests can inject a fake captcha without Cloudflare's script touching jsdom.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
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
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITEKEY,
          action: TURNSTILE_ACTION,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch((error) => {
        // Fails the gate closed (submit stays disabled), but a script/CDN outage blocks ALL logins, so
        // surface it — otherwise it presents as "the send button never enables" with no signal.
        console.warn(
          "turnstile load/render failed",
          error instanceof Error ? error.message : error,
        );
        onToken(null);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken]);

  // The action is passed to render() above (explicit render); data-action is an informational marker
  // (the turnstile-spin-v1 activation tag) — the auto-render path would read it, explicit render ignores it.
  return <div ref={containerRef} className="cf-turnstile" data-action={TURNSTILE_ACTION} />;
}
