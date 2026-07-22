// Post-build guard for the static export. Run after `next build` (output: "export"): it asserts the
// artifacts the Cloudflare deploy depends on actually made it into out/, so a broken export fails
// BEFORE it ships, not after. The a11y/Lighthouse jobs serve out/ without applying _headers, so the
// header behaviours below are invisible to them — this is the one place we check them in CI.
//
// It is ROUTE-AWARE: the fixed infra files below are joined with the per-page HTML derived from the
// emitted out/sitemap.xml (itself built from the route manifest). So a route added to the manifest
// that fails to emit its page is caught here, not discovered live.
//
// Runnable locally via `pnpm --filter @webhook-co/www check:export`; wired into the deploy workflow.
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { extractSitemapLocs, pageFileForUrl } from "./check-seo-html.mjs";

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
const failures = [];

// The one upload endpoint the beacon may post to, compared with `===` — never a substring scan.
// Kept in lockstep with the connect-src entry in public/_headers and with
// src/components/marketing/web-analytics.tsx.
const CF_MANUAL_UPLOAD_ENDPOINT = "https://cloudflareinsights.com/cdn-cgi/rum";

// Infra files the host needs regardless of page count: the homepage, the custom 404
// (not_found_handling: "404-page"), the headers file, the SEO routes, and the social card.
// index.html is listed UNCONDITIONALLY (not only when "/" appears in the sitemap) — a homepage that
// opted out of the sitemap would still have to exist, and "/" 404ing is the worst failure to miss.
// bimi/* are referenced by DNS, not by any page, so nothing else in the build would notice them going
// missing: `default._bimi.{mail,billing}.webhook.co` carries `l=https://www.webhook.co/bimi/logo.svg`.
// If that URL 404s, mailbox providers record a BIMI *failure* and the brand logo silently disappears
// from every inbox — with a fully green build. They are infra, not content.
const infra = [
  "index.html",
  "404.html",
  "_headers",
  "sitemap.xml",
  "robots.txt",
  // A curated, machine-readable index for answer engines (llmstxt.org). It ships as a static file
  // under public/, so `output: 'export'` must copy it into out/ — asserted here because a static file
  // that silently stops emitting looks identical to a green build. docs.webhook.co already serves one.
  "llms.txt",
  "og.png",
  "bimi/logo.svg",
  "bimi/apple-branded-mail.png",
];

// Every page the sitemap advertises must have actually been emitted.
let pageFiles = [];
try {
  const sitemap = await readFile(outDir + "sitemap.xml", "utf8");
  const locs = extractSitemapLocs(sitemap);
  if (locs.length === 0) failures.push("out/sitemap.xml lists no <loc> — export emitted no pages");
  pageFiles = locs.map((loc) => pageFileForUrl(loc));
} catch {
  failures.push("could not read out/sitemap.xml to derive the required page list");
}

// Dedupe: index.html is in `infra` unconditionally AND is the "/" route's derived pageFile, so it
// would otherwise be checked twice.
const required = [...new Set([...infra, ...pageFiles])];
for (const rel of required) {
  try {
    await access(outDir + rel);
  } catch {
    failures.push(`missing out/${rel}`);
  }
}

// Spot-check the two header behaviours that have bitten us before: the immutable cache rule scoped
// to the content-hashed assets, and the CSP/HSTS that the static host can't add any other way.
try {
  const headers = await readFile(outDir + "_headers", "utf8");
  if (!/\/_next\/static\/\*/.test(headers) || !/immutable/.test(headers)) {
    failures.push("out/_headers is missing the immutable /_next/static/* cache rule");
  }
  // Assert the CSP keeps script-src 'unsafe-inline' — narrowing it to a bare 'self' returns 200 but
  // silently breaks Next's inline hydration, which no other CI job would catch.
  if (!/Content-Security-Policy:[^\n]*script-src[^;]*'unsafe-inline'/i.test(headers)) {
    failures.push("out/_headers CSP is missing or its script-src dropped 'unsafe-inline'");
  }
  if (!/Strict-Transport-Security:/i.test(headers)) {
    failures.push("out/_headers is missing Strict-Transport-Security");
  }

  // ── The ADDITIVE-header trap. Cloudflare _headers rules do not override, they ACCUMULATE. Both
  // checks below exist because of it; the /play one is here because it already shipped broken once.

  // The BIMI indicator has the same trap, with a worse blast radius. Workers Static Assets ALREADY
  // infers `Content-Type: image/svg+xml` from the .svg extension, so pinning it again without
  // unsetting first ships the header TWICE — which a receiver reads as the invalid media type
  // `image/svg+xml, image/svg+xml`. With the global `nosniff` that is unrecoverable: the indicator is
  // rejected as malformed and BIMI returns a *failure*, strictly worse than publishing no BIMI record
  // at all. No browser test can see it — the logo is fetched by mailbox providers at delivery time.
  const bimiBlock = headers.split(/^\/(?=\S)/m).find((b) => b.startsWith("bimi/logo.svg\n"));
  if (!bimiBlock) {
    failures.push(
      "out/_headers has no /bimi/logo.svg block (the BIMI indicator needs a pinned type)",
    );
  } else {
    if (!/^\s*!\s*Content-Type\s*$/im.test(bimiBlock)) {
      failures.push(
        "out/_headers /bimi/logo.svg does not UNSET the inherited Content-Type (`! Content-Type`) — " +
          "two Content-Type headers make the indicator unparseable and turn BIMI into a hard failure",
      );
    }
    if (!/Content-Type:\s*image\/svg\+xml/i.test(bimiBlock)) {
      failures.push("out/_headers /bimi/logo.svg must set Content-Type: image/svg+xml");
    }
  }

  // /play MUST unset the inherited CSP before setting its own. This shipped broken to production:
  // without the `!` line /play is served with TWO Content-Security-Policy headers — and a browser
  // enforces their INTERSECTION, not "most specific wins". The global `script-src 'self'` therefore
  // still blocked challenges.cloudflare.com, the Turnstile script never loaded, and the sandbox's mint
  // button stayed disabled forever. No other check could see it: the a11y/Lighthouse jobs serve out/
  // WITHOUT applying _headers at all.
  const playBlock = headers.split(/^\/(?=\S)/m).find((b) => b.startsWith("play\n"));
  if (!playBlock) {
    failures.push("out/_headers has no /play block (the sandbox needs its own CSP)");
  } else {
    if (!/^\s*!\s*Content-Security-Policy\s*$/im.test(playBlock)) {
      failures.push(
        "out/_headers /play does not UNSET the inherited CSP (`! Content-Security-Policy`) — " +
          "two CSP headers intersect, which blocks Turnstile and disables the mint button",
      );
    }
    if (
      !/Content-Security-Policy:[^\n]*script-src[^;]*challenges\.cloudflare\.com/i.test(playBlock)
    ) {
      failures.push("out/_headers /play CSP must allow challenges.cloudflare.com in script-src");
    }
    if (!/Content-Security-Policy:[^\n]*connect-src[^;]*play\.wbhk\.my/i.test(playBlock)) {
      failures.push("out/_headers /play CSP must allow play.wbhk.my in connect-src");
    }
  }

  // ── The Cloudflare Web Analytics beacon needs a MATCHED PAIR of CSP entries, in EVERY block ──
  // script-src loads beacon.min.js; connect-src is where it uploads. www.webhook.co is a Workers
  // custom domain whose /cdn-cgi/rum 404s, so the beacon is embedded by hand and uploads CROSS-ORIGIN
  // to cloudflareinsights.com — 'self' does not cover it. Drop either entry and the beacon dies
  // silently: no user-visible breakage, no failing test, just a dashboard that reads zero forever
  // (which is exactly how this shipped — measured 0 events over 7 days on 2026-07-22).
  //
  // Checked per-block, not once over the whole file, BECAUSE /play unsets the inherited CSP. A global
  // grep would pass while /play — a real page rendering the same root layout — served a policy that
  // blocks the beacon.
  const cspBlocks = [
    ["/*", headers.split(/^\/(?=\S)/m).find((b) => b.startsWith("*\n"))],
    ["/play", playBlock],
  ];
  for (const [label, block] of cspBlocks) {
    if (!block || !/Content-Security-Policy:/i.test(block)) continue;
    if (
      !/Content-Security-Policy:[^\n]*script-src[^;]*static\.cloudflareinsights\.com/i.test(block)
    ) {
      failures.push(
        `out/_headers ${label} CSP must allow static.cloudflareinsights.com in script-src ` +
          "(without it beacon.min.js is blocked and Web Analytics records nothing)",
      );
    }
    if (
      !/Content-Security-Policy:[^\n]*connect-src[^;]*(?<![.\w])cloudflareinsights\.com/i.test(
        block,
      )
    ) {
      failures.push(
        `out/_headers ${label} CSP must allow cloudflareinsights.com in connect-src ` +
          "(the manually-embedded beacon uploads cross-origin; 'self' does not cover it)",
      );
    }
  }
} catch {
  failures.push("could not read out/_headers");
}

// THE BEACON-SHAPE GUARD. Two shapes load fine and report NOTHING, and neither is visible from the
// browser (the script 200s, the upload 204s), so the emitted HTML is the only place to catch them:
//   1. `type="module"` — Cloudflare's beacon resolves its own element via document.currentScript,
//      which is ALWAYS null for a module script, so it never finds its token.
//   2. a missing/!32-hex data-cf-beacon token — nothing to report against.
// Also asserted: the pinned upload endpoint, which must stay in lockstep with the connect-src entry
// above. Mirrors scripts/docs-structured-data-guard.mjs, which pins the same shape for the docs site.
try {
  const html = await readFile(outDir + "index.html", "utf8");
  const beaconTag = /<script[^>]*static\.cloudflareinsights\.com\/beacon\.min\.js[^>]*>/i.exec(
    html,
  )?.[0];
  if (!beaconTag) {
    failures.push(
      "out/index.html has no Cloudflare Web Analytics beacon — the webhook.co zone's AUTOMATIC setup " +
        "cannot inject one (www.webhook.co is a Workers custom domain: its /cdn-cgi/rum 404s), so the " +
        "manual embed in src/components/marketing/web-analytics.tsx is the only thing that reports",
    );
  } else {
    if (/type=["']module["']/i.test(beaconTag)) {
      failures.push(
        "out/index.html beacon is a MODULE script — document.currentScript is null for modules, so " +
          "Cloudflare's beacon cannot resolve its token and silently never reports",
      );
    }
    // PARSE the config rather than scanning the tag for substrings. Scanning was wrong twice over:
    // it read a token out of whatever the regex happened to reach, and CodeQL correctly flagged the
    // endpoint check (js/regex/missing-regexp-anchor) because an unanchored match accepts any host
    // that merely CONTAINS the real one. Decode the HTML entities React emitted, JSON.parse, then
    // compare exactly — this is the one guard whose whole job is pinning where our data goes.
    let config;
    try {
      const raw = /data-cf-beacon="([^"]*)"/i.exec(beaconTag)?.[1] ?? "";
      config = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    } catch {
      config = null;
    }
    if (!config || typeof config.token !== "string" || !/^[0-9a-f]{32}$/.test(config.token)) {
      failures.push(
        "out/index.html beacon has no valid 32-hex data-cf-beacon token — it would load and report nothing",
      );
    }
    if (config?.send?.to !== CF_MANUAL_UPLOAD_ENDPOINT) {
      failures.push(
        `out/index.html beacon does not pin send.to to exactly ${CF_MANUAL_UPLOAD_ENDPOINT} — it can ` +
          "fall back to same-origin /cdn-cgi/rum, which 404s on this Workers custom domain",
      );
    }
  }
} catch {
  failures.push("could not read out/index.html to check the Web Analytics beacon");
}

// THE FLASH-OF-WRONG-THEME GUARD. The site is a static export: there is no server to read a cookie, so
// the theme is applied by an inline script that stamps `data-theme` on <html>. It must be in <head> —
// everything there runs before the first paint. Move it into <body> (or into a React effect) and a
// dark-mode reader gets a white flash on every single navigation.
//
// Checked HERE, structurally, because it cannot be checked at runtime: a Playwright probe at
// `readyState: interactive` STILL PASSES with the script at the end of <body>, because interactive
// fires after body scripts run — verified by mutation. Where the tag sits in the emitted HTML is the
// thing that actually decides it.
//
// (Its position relative to the stylesheet <link> is deliberately NOT asserted: stylesheets are
// render-blocking, so a script anywhere in <head> executes before paint either way. Asserting that
// would be a guard that fails on correct code.)
try {
  const html = await readFile(outDir + "index.html", "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const themeInHead = /<script[^>]*>[^<]*data-theme[^<]*<\/script>/.test(head);

  if (!/data-theme/.test(html)) {
    failures.push("out/index.html has no inline theme-init script — dark mode would flash on load");
  } else if (!themeInHead) {
    failures.push(
      "the theme-init script is not in <head> — it must run before the first paint, or dark-mode " +
        "readers get a white flash on every navigation",
    );
  }
} catch {
  failures.push("could not read out/index.html");
}

if (failures.length > 0) {
  console.error("check:export failed:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log(`check:export ok — verified ${required.length} artifacts + header rules in out/`);
