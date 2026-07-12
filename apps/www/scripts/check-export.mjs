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

// Infra files the host needs regardless of page count: the homepage, the custom 404
// (not_found_handling: "404-page"), the headers file, the SEO routes, and the social card.
// index.html is listed UNCONDITIONALLY (not only when "/" appears in the sitemap) — a homepage that
// opted out of the sitemap would still have to exist, and "/" 404ing is the worst failure to miss.
const infra = ["index.html", "404.html", "_headers", "sitemap.xml", "robots.txt", "og.png"];

// Every page the sitemap advertises must have actually been emitted.
let pageFiles = [];
try {
  const sitemap = await readFile(outDir + "sitemap.xml", "utf8");
  const locs = extractSitemapLocs(sitemap);
  if (locs.length === 0) failures.push("out/sitemap.xml lists no <loc> — export emitted no pages");
  // Not `locs.map(pageFileForUrl)` — map passes (element, index), and the index would land in
  // pageFileForUrl's `host` param, defeating the host-strip. Call it with the URL only.
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

  // /play MUST unset the inherited CSP before setting its own. This shipped broken to production:
  // Cloudflare _headers rules are ADDITIVE, so without the `!` line /play is served with TWO
  // Content-Security-Policy headers — and a browser enforces their INTERSECTION, not "most specific
  // wins". The global `script-src 'self'` therefore still blocked challenges.cloudflare.com, the
  // Turnstile script never loaded, and the sandbox's mint button stayed disabled forever. No other
  // check could see it: the a11y/Lighthouse jobs serve out/ WITHOUT applying _headers at all.
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
} catch {
  failures.push("could not read out/_headers");
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
