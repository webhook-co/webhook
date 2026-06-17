// Post-build guard for the static export. Run after `next build` (output: "export"): it asserts the
// artifacts the Cloudflare deploy depends on actually made it into out/, so a broken export fails
// BEFORE it ships, not after. The a11y/Lighthouse jobs serve out/ without applying _headers, so the
// header behaviours below are invisible to them — this is the one place we check them in CI.
//
// Runnable locally via `pnpm --filter @webhook-co/www check:export`; wired into the deploy workflow.
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
const failures = [];

// Files the host needs: the homepage, the custom 404 (not_found_handling: "404-page"), the headers
// file, the SEO routes, and the social card.
const required = ["index.html", "404.html", "_headers", "sitemap.xml", "robots.txt", "og.png"];
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
} catch {
  failures.push("could not read out/_headers");
}

if (failures.length > 0) {
  console.error("check:export failed:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log(`check:export ok — verified ${required.length} artifacts + header rules in out/`);
