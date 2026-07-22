/* global document, window */
// Cloudflare Web Analytics — cookieless, privacy-first Real User Monitoring. It sets no cookies, uses
// no localStorage, and needs no consent banner (https://developers.cloudflare.com/web-analytics/). The
// token below is a PUBLIC beacon site token (Cloudflare renders it into every page's HTML) — not a
// credential.
//
// docs.webhook.co is a Mintlify site reached by a DNS-only CNAME (it is NOT proxied through our own
// Cloudflare zone), so the beacon is added manually. Mintlify runs any .js file in the content directory
// on every page and recommends injecting a <script> element (https://mintlify.com/docs/customize/custom-scripts).
//
// We inject a CLASSIC <script> carrying the token in the `data-cf-beacon` attribute. That is deliberate:
// Cloudflare's beacon locates its own <script> via `document.currentScript` (or a `script[data-cf-beacon]`
// querySelector fallback). `document.currentScript` is null for module scripts, so a module + `?token=`
// injection loads but silently reports nothing; a classic script + `data-cf-beacon` attribute resolves
// through both paths. docs-structured-data-guard.mjs enforces this (it rejects a module script and
// requires the attribute token).
//
// ── Why the two extra knobs below are load-bearing (measured on the live site 2026-07-22) ──
// Mintlify's own platform ALSO injects a Cloudflare Web Analytics beacon into <head> (their token, as a
// versioned + integrity-pinned module script). Two facts about beacon.min.js make that fatal for us:
//
//  1. It is single-instance. It opens with
//         let p = window.__cfBeacon ? window.__cfBeacon : {};
//         if (p && "single" === p.load) return;
//     and every instance stamps `p.load = "single"` before publishing the global. Mintlify's runs in
//     <head>, ours is appended after hydration — so ours ALWAYS lost the race and returned before it
//     ever read our token. Symptom: beacon.min.js 200s and a /cdn-cgi/rum POST 204s, so DevTools looks
//     healthy, while our site tag recorded ZERO events for 7 days and every page view was reported
//     into Mintlify's account. Resetting the global to `load: "multi"` is what lets a second beacon
//     run at all.
//
//     Assigning a FRESH object (rather than merging) is intentional and order-independent: Mintlify's
//     beacon has already captured its own config object in a closure, so replacing the global cannot
//     disturb their reporting; and in the reverse order theirs simply merges its own attribute over
//     ours, losing nothing. A fresh object also avoids inheriting their `version`, which feeds (2).
//
//  2. Its upload endpoint resolves as
//         p.send && p.send.to ? p.send.to : (undefined === p.version ? <cloudflareinsights> : null)
//     where a null endpoint means same-origin `/cdn-cgi/rum`. On docs.webhook.co that origin is
//     MINTLIFY's Cloudflare zone, which answers 204 for a token it does not own and drops the event —
//     a beacon that looks like it is working from every client-side signal. Now that we share the
//     global with their config we pin `send.to` explicitly to the documented manual-embed endpoint
//     rather than inferring it from the absence of `version`.
(function () {
  // Must be set BEFORE the beacon executes, and it is read off the GLOBAL (not our attribute), so it
  // cannot ride along in `data-cf-beacon` below.
  window.__cfBeacon = { load: "multi" };

  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  // The token is a PUBLIC Cloudflare Web Analytics beacon site token (see header) — not a credential;
  // `gitleaks:allow` marks the secret scanner's generic-api-key false positive on its 32-hex entropy.
  const config = {
    token: "7b5208f819674518a2d12e97bd6f6cf3", // gitleaks:allow
    // Kept on OUR attribute rather than the shared global so we never redirect Mintlify's uploads.
    send: { to: "https://cloudflareinsights.com/cdn-cgi/rum" },
  };
  beacon.setAttribute("data-cf-beacon", JSON.stringify(config));
  document.head.appendChild(beacon);
})();
