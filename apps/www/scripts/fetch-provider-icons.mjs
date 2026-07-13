// Fetch a brand icon for every provider that has no official vector mark, ONCE, and commit the result.
//
//   node --experimental-strip-types scripts/fetch-provider-icons.mjs [--force]
//
// WHY THIS SHAPE. 78 of the 142 providers ship an official single-path CC0 mark in @webhook-co/ui.
// The other 64 don't (Simple Icons has dropped many brands over trademark policy), and the dashboard
// covers them with a live favicon-proxy Worker route backed by R2 — a mechanism a STATIC EXPORT does
// not have. So we resolve those icons at BUILD time, store them in `public/providers/`, and commit
// them. At runtime the marketing site therefore serves same-origin static files: no third-party
// request from a visitor's browser, no `img-src 'self'` CSP change, no dependency on a free API
// staying up, and no per-render lookup. Re-run this script only when a provider is added.
//
// SOURCE. Google's favicon service (`s2/favicons`), because it was the only one that actually worked
// for all 64 when measured:
//   - Clearbit's logo API returned 0/64 — it has been sunset.
//   - DuckDuckGo's returned 60/64, and a mix of .ico and .png (an .ico can't be fed to cwebp).
//   - Google returned 64/64, always as PNG, at up to 128px.
// It also returns an EMPTY body for a domain it doesn't know, rather than a generic globe — verified
// against a nonsense domain — so there is no way to accidentally ship a placeholder that pretends to
// be someone's brand. We still refuse anything suspiciously small, and never invent a fallback.
//
// These are brand marks used NOMINATIVELY, to identify an integration we verify — the same posture,
// and the same icons, the dashboard already uses.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_ENTRIES } from "../src/components/marketing/provider-entries.ts";
import { isMainModule } from "./check-seo-html.mjs";

const OUT_DIR = fileURLToPath(new URL("../public/providers/", import.meta.url));
const FORCE = process.argv.includes("--force");
/** Display size is 14px; 32px covers a 2x display without paying for pixels nobody sees. */
const SIZE = 32;
/** Below this, the response is not a usable icon (an empty body, or a 1px tracking pixel). */
const MIN_BYTES = 100;
/** A 128px favicon is a few KB. Anything past this is not an icon — refuse it rather than write it. */
const MAX_BYTES = 512 * 1024;
/** The 8-byte PNG signature (RFC 2083 §3.1). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Is this response body an icon we are willing to put on disk? The bytes come off the network, and
 * `cwebp` is then handed the file — so we sniff CONTENT rather than trusting the declared type or
 * the URL: an oversized or non-PNG body is refused before it is ever written. Pure; returns the
 * reason it was refused, or null when the buffer is acceptable.
 */
export function rejectIcon(buf, status) {
  if (status !== 200) return `HTTP ${status}`;
  if (buf.length < MIN_BYTES) return `too small (${buf.length}B)`;
  if (buf.length > MAX_BYTES) return `too large (${buf.length}B)`;
  if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "not a PNG";
  return null;
}

/** Google returns PNG; cwebp reads PNG. `-metadata none` strips anything the source carried. */
function toWebp(pngPath, outPath) {
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    "82",
    "-resize",
    String(SIZE),
    String(SIZE),
    "-metadata",
    "none",
    pngPath,
    "-o",
    outPath,
  ]);
}

async function main() {
  const needIcon = PROVIDER_ENTRIES.filter((p) => !p.mark);
  if (needIcon.some((p) => !p.domain)) {
    console.error(
      "✗ a provider without a vector mark also has no domain — cannot resolve an icon:",
    );
    for (const p of needIcon.filter((x) => !x.domain)) console.error(`   ${p.slug}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const existing = new Set(
    readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".webp"))
      .map((f) => f.replace(/\.webp$/, "")),
  );

  let fetched = 0;
  let skipped = 0;
  const failed = [];

  for (const { slug, domain, name } of needIcon) {
    if (existing.has(slug) && !FORCE) {
      skipped++;
      continue;
    }
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
    try {
      const res = await fetch(url, { headers: { "user-agent": "webhook.co-icon-fetch" } });
      const buf = Buffer.from(await res.arrayBuffer());
      // An unknown domain comes back empty. Refuse it loudly rather than write a broken/blank icon —
      // a provider silently rendering a 0-byte image is worse than one honestly rendering a monogram.
      const reason = rejectIcon(buf, res.status);
      if (reason) {
        failed.push(`${slug} (${domain}) — ${reason}`);
        continue;
      }
      const tmp = join(OUT_DIR, `${slug}.src.png`);
      writeFileSync(tmp, buf);
      toWebp(tmp, join(OUT_DIR, `${slug}.webp`));
      rmSync(tmp);
      fetched++;
      console.log(`  ✓ ${name} (${domain})`);
    } catch (err) {
      failed.push(`${slug} (${domain}) — ${err.message}`);
    }
  }

  console.log(
    `\n${fetched} fetched, ${skipped} already present, ${failed.length} unresolved (of ${needIcon.length} logo-less providers).`,
  );
  if (failed.length > 0) {
    // Not fatal: a provider with no resolvable icon renders the monogram tile, which is a fine, honest
    // fallback. But say so out loud — a silent gap is how the wall starts quietly lying.
    console.log("\nUnresolved (these will render the monogram tile):");
    for (const f of failed) console.log(`  · ${f}`);
  }
  console.log("\nCommit public/providers/ — the site serves these as static, same-origin assets.");
}

// Only fetch when RUN. Importing this module (the unit test does) must not touch the network or the
// filesystem — same guard `check-seo-html.mjs` uses, and for the same reason.
if (isMainModule(import.meta.url, process.argv[1])) await main();
