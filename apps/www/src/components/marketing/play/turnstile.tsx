"use client";

import { useEffect, useRef } from "react";

// The Cloudflare Turnstile challenge for the /play mint. Adapted from apps/auth's login widget: an
// EXPLICIT render (not the implicit auto-render), so the solved token arrives in a closure rather than
// a global — the React-friendly path. The widget theme is resolved from `<html data-theme>` at mount
// so the challenge card matches the page — which defaults to dark (with a nav toggle to light) — rather
// than the OS. It is read once at render time (the token is single-use and remounts anyway); a live
// toggle mid-challenge is not tracked, unlike the login widget's observer.
//
// WHY IT EXISTS: minting a sandbox is unauthenticated and costs us a Durable Object. Without a
// challenge, /play is a free, scriptable resource generator on our highest-traffic page. In prod the
// worker runs TURNSTILE_MODE=on and REFUSES a mint without a valid token (403 challenge_failed), so
// this widget is not decoration — it is the thing that makes the mint work at all.
//
// The sitekey is PUBLIC by design (Cloudflare's own docs put it in the markup); only the secret, which
// lives on the worker, can verify a token. The CSP for /play already allows challenges.cloudflare.com
// for script, frame and connect.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_ACTION = "play-mint";

/** The prod widget ("webhook-play mint"), overridable at build. Empty string disables the challenge. */
export const DEFAULT_SITEKEY = "0x4AAAAAAD0VeZTVJhxK6CZf";

/**
 * Read at call time, not module load, so a test (and a local `next dev`) can switch it off with
 * `NEXT_PUBLIC_TURNSTILE_SITEKEY=""` — the local play worker runs TURNSTILE_MODE=off and doesn't want
 * a challenge it would ignore.
 */
export function playSitekey(): string {
  const configured = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY;
  return configured === undefined ? DEFAULT_SITEKEY : configured;
}

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      size?: "normal" | "compact" | "flexible";
      theme?: "light" | "dark" | "auto";
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
 * The widget theme to match the page's current mode — the `data-theme` attribute on `<html>` (set by
 * the shared pre-paint init script), defaulting to the product default (dark) when unset, independent
 * of the OS. Read at render, inside the mount effect, where `data-theme` is already stamped.
 */
function resolveTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
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
 * Renders the challenge and reports the solved token via `onToken` — and `onToken(null)` when it
 * expires, errors, or the script fails to load, so the mint button stays gated rather than firing a
 * request the worker will refuse.
 *
 * The token is SINGLE-USE. The caller gets a fresh one by remounting this component with a new `key`.
 */
export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: playSitekey(),
          action: TURNSTILE_ACTION,
          size: "flexible",
          theme: resolveTheme(), // match the page theme (dark by default), not the OS
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch((error: unknown) => {
        // Fails CLOSED (the mint button stays disabled) — but a CDN outage would then block every
        // sandbox with no signal at all, presenting as "the button never enables". Say so.
        console.warn(
          "turnstile load/render failed",
          error instanceof Error ? error.message : error,
        );
        onToken(null);
      });

    return () => {
      cancelled = true;
      if (widgetId !== undefined && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken]);

  return <div ref={containerRef} className="flex justify-center" />;
}
