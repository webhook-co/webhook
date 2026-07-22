// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { absoluteUrl } from "./metadata";
import { sitemapRoutes } from "@/lib/routes";

// `public/llms.txt` is a curated, machine-readable index of the marketing site for answer engines
// (the llmstxt.org convention). It ships as a plain static file, which `output: 'export'` copies
// verbatim into `out/llms.txt` — `check-export.mjs` asserts it survives the export. These tests pin
// the two things a static file rots on: its shape, and whether the URLs it hands an LLM are real.
const LLMS_TXT = readFileSync(
  fileURLToPath(new URL("../../public/llms.txt", import.meta.url)),
  "utf8",
);

describe("public/llms.txt", () => {
  it("is a well-formed llms.txt: an H1 title and a summary blockquote", () => {
    // The llmstxt.org format is an H1 name, then a `>` blockquote summarising the project.
    expect(LLMS_TXT, "llms.txt must open with a single `# ` H1").toMatch(/^# webhook\.co\b/);
    expect(LLMS_TXT, "llms.txt must carry a `>` summary blockquote").toMatch(/^> \S/m);
    // Brand names are lowercase — the file must never introduce a capitalised "Webhook.co".
    expect(LLMS_TXT).not.toMatch(/Webhook\.co/);
  });

  it("links only real, sitemapped www routes — no 404 handed to a crawler", () => {
    const urls = [...LLMS_TXT.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!);
    // Non-vacuous: a curated index with no links is not an index.
    expect(urls.length, "llms.txt lists no links").toBeGreaterThan(3);

    const sitemapped = new Set(sitemapRoutes().map((r) => absoluteUrl(r.path)));
    // Off-www links leave the sitemap's reach, so they are held to an explicit host allowlist instead —
    // otherwise a typo in the docs/GitHub URL ships the exact dead link this test claims to prevent.
    const ALLOWED_HOSTS = new Set(["www.webhook.co", "docs.webhook.co", "github.com"]);
    for (const url of urls) {
      const host = new URL(url).hostname;
      expect(ALLOWED_HOSTS.has(host), `llms.txt links an unexpected host: ${url}`).toBe(true);
      if (host === "www.webhook.co") {
        expect(
          sitemapped.has(url),
          `llms.txt links a www URL that is not a sitemapped route: ${url}`,
        ).toBe(true);
      }
    }
    // At least one link must actually be one of ours — otherwise the sitemap check above is vacuous.
    expect(
      urls.some((u) => u.startsWith("https://www.webhook.co")),
      "llms.txt links none of our own pages",
    ).toBe(true);
  });
});
