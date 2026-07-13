"use client";

import * as React from "react";

/**
 * Reload an authenticated page when the browser restores it from the back/forward cache.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────────────
 *
 * A bfcache restore is not a page load. The document is resurrected from memory with its DOM and JS heap
 * intact: no network request, no revalidation, no server render, and therefore NO session check. Every gate
 * we have — `verifySession`, `requireOrgAccess`, RLS — runs on the server, and none of them runs here.
 *
 * `Cache-Control: no-store` does NOT keep a page out of the bfcache. That is the trap: it evicts the page
 * from the HTTP *disk* cache, which is a different cache, and it is easy to read the two as one thing. Chrome
 * bfcaches no-store pages.
 *
 * So on a shared machine: sign out on `/org/acme/endpoints/ep_123`, land on the login form, and the next
 * person presses Back — the endpoint page repaints from memory, fully rendered, still showing the ingest URL,
 * which is a bearer credential (that page is `force-dynamic` precisely because its HTML embeds one).
 *
 * `Clear-Site-Data: "cache"` used to cover this, because the spec's `"cache"` type evicts bfcache entries
 * too. But that header was also purging the HTTP cache for the whole registrable domain, which BLOCKED the
 * logout navigation for ~25 seconds (measured). We dropped it — so this takes over the one job it was
 * actually still doing, deterministically and for free.
 *
 * ── Why a reload, unconditionally ───────────────────────────────────────────────────────────────────────
 *
 * We cannot ask "is the session still valid?" from here: the session cookie is `httpOnly`, so script cannot
 * see it, and that is not a property to trade away for this. So we do the one thing that always gives the
 * right answer — go back to the server. If the session is alive, the page re-renders as it was and the user
 * sees a flicker. If it is gone, the DAL gate redirects to sign-in, which is the entire point.
 *
 * This is cheap: bfcache only applies to full document navigations (leaving the origin and coming back).
 * In-app Back is a client-side router navigation and never touches this path.
 */
export function BfcacheGuard() {
  React.useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      // `persisted` is true ONLY for a bfcache restore — not for a normal load, so this never fires on the
      // happy path.
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return null;
}
