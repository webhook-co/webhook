"use client";

import { useEffect, useState } from "react";

import {
  StatusIndicator,
  safeColor,
  safeMessage,
  type StatusBadge,
} from "@/components/marketing/status-indicator";

/**
 * Client half of the footer status indicator: fetches our OWN `/api/status` after mount.
 *
 * Client-side, not server-side, for a specific reason rather than preference. Fetching during server
 * render made `Footer` a suspense boundary and broke every page test that renders it — the RSC
 * boundary. Doing it after mount keeps `Footer` synchronous and leaves the server-rendered HTML
 * byte-identical, so the indicator is purely additive.
 *
 * The request is SAME-ORIGIN, which is what preserves the reasons for not using Phare's iframe: no
 * third-party frame, no CSP change, no third-party request on a consented site. The vendor call
 * happens in the route handler, cached, out of the visitor's browser.
 *
 * It renders nothing until it has a verdict, and nothing at all if the fetch fails — so the footer's
 * initial paint is unchanged and a bad status vendor can never degrade the page.
 */
export function LiveStatusIndicator({ className }: { className?: string }) {
  const [status, setStatus] = useState<StatusBadge | null>(null);

  useEffect(() => {
    // Guards a setState after unmount, which in a footer means any client-side navigation away
    // before the vendor answers.
    let live = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch("/api/status", { signal: controller.signal });
        if (!res.ok || res.status === 204) return; // 204 = the vendor had nothing trustworthy
        const body: unknown = await res.json();
        if (typeof body !== "object" || body === null) return;
        const { message, color } = body as { message?: unknown; color?: unknown };
        const safe = safeMessage(message);
        // Re-validated here even though the route handler already did. This is the boundary that
        // actually writes into the DOM, and it costs nothing to not depend on an upstream promise.
        if (live && safe !== null) setStatus({ message: safe, color: safeColor(color) });
      } catch {
        // Swallowed: the footer must render whether or not the status endpoint answers.
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  return <StatusIndicator status={status} className={className} />;
}
