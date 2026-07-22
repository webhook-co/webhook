// Cloudflare Web Analytics for www.webhook.co — cookieless, privacy-first Real User Monitoring. It
// sets no cookies and uses no localStorage, so it sits OUTSIDE the consent banner (which gates the
// first-touch attribution cookie, ADR-0128) and ships on every page view. Disclosed on /privacy.
//
// The token is a PUBLIC beacon site token — Cloudflare renders it into the HTML of every page it
// auto-instruments — not a credential.
//
// ── Why this is embedded by hand, when the dashboard says "automatic setup" ──
// The webhook.co site was registered for Cloudflare's AUTOMATIC setup, which injects the beacon at the
// edge for proxied zones. That can never fire here: www.webhook.co is a Workers CUSTOM DOMAIN (static
// export behind `run_worker_first: true`, see wrangler.jsonc), and edge beacon injection does not run
// for Workers-served responses. Proof, measured 2026-07-22: `GET https://www.webhook.co/cdn-cgi/rum`
// returns 404 from the Worker's own 404 page rather than the 405 a live Cloudflare RUM endpoint
// returns, no page in the export ever contained a beacon, and the site tag recorded ZERO events over
// 7 days. app.webhook.co and auth.webhook.co are Workers custom domains too, so the zone's automatic
// setup is inert everywhere on it. A manual embed is the only form that works.
//
// ── Two shapes that would ship a DEAD beacon ──
//  1. A CLASSIC <script> (never `type="module"`) carrying the token in `data-cf-beacon`. Cloudflare's
//     beacon finds its own element via `document.currentScript` — always null for a module script —
//     with a `script[data-cf-beacon]` querySelector fallback. Classic + attribute resolves via both
//     paths; module + `?token=` loads and silently reports nothing.
//  2. `send.to` pinned to the manual-embed endpoint. beacon.min.js resolves its upload target as
//     `p.send && p.send.to ? p.send.to : (undefined === p.version ? <cloudflareinsights> : null)`,
//     and a null endpoint means same-origin `/cdn-cgi/rum` — which, per above, 404s on this host. It
//     would default correctly today (we set no `version`), but pinning it makes the target explicit
//     and keeps it in lockstep with the `connect-src` entry in public/_headers.
//
// Both shapes, and the matching CSP entries, are enforced by apps/www/scripts/check-export.mjs
// against the BUILT export — the beacon has no other CI signal, and every failure mode above still
// looks perfectly healthy from the browser (script 200s, upload 204s).

// A public Cloudflare Web Analytics beacon site token, not a credential (see header); `gitleaks:allow`
// marks the secret scanner's generic-api-key false positive on its 32-hex entropy.
const CF_BEACON_TOKEN = "c18db0638ed94235909a96bf7a17308b"; // gitleaks:allow

const CF_BEACON_CONFIG = JSON.stringify({
  token: CF_BEACON_TOKEN,
  send: { to: "https://cloudflareinsights.com/cdn-cgi/rum" },
});

export function WebAnalytics() {
  return (
    <script
      defer
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={CF_BEACON_CONFIG}
    />
  );
}
