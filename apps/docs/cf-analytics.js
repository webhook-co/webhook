/* global document */
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
(function () {
  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  // The token is a PUBLIC Cloudflare Web Analytics beacon site token (see header) — not a credential;
  // `gitleaks:allow` marks the secret scanner's generic-api-key false positive on its 32-hex entropy.
  const config = { token: "7b5208f819674518a2d12e97bd6f6cf3" }; // gitleaks:allow
  beacon.setAttribute("data-cf-beacon", JSON.stringify(config));
  document.head.appendChild(beacon);
})();
