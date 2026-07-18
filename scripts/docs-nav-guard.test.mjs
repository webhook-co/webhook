import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectNavPages,
  parseFrontmatter,
  extractInternalLinks,
  auditDocs,
} from "./docs-nav-guard.mjs";

/**
 * `apps/docs` (the Mintlify site) had NO CI protection: a nav entry pointing at a deleted page, a new
 * page nobody linked, a page missing its frontmatter, or a broken cross-link all shipped green,
 * because Mintlify builds the site externally and the only check was a local `mint broken-links`
 * nobody runs. This guard parses docs.json + the MDX tree and fails the required `pnpm lint` on any of
 * those. It PARSES (JSON + a frontmatter/link extractor); it never text-scans (see the sibling
 * no-unverified-claims guard and the guard-scripts-must-parse-not-scan lesson).
 */

// ── collectNavPages: pull every page-path leaf out of the Mintlify nav tree ────

test("collectNavPages walks tabs, groups, nested groups, and tab.pages", () => {
  const config = {
    navigation: {
      tabs: [
        {
          tab: "Docs",
          groups: [
            { group: "A", pages: ["intro", "a/one", "a/two"] },
            {
              group: "B",
              pages: ["b/root", { group: "Nested", pages: ["b/n/deep"] }],
            },
          ],
        },
        { tab: "Flat", pages: ["flat/x", "flat/y"] },
      ],
    },
  };
  assert.deepEqual(collectNavPages(config).sort(), [
    "a/one",
    "a/two",
    "b/n/deep",
    "b/root",
    "flat/x",
    "flat/y",
    "intro",
  ]);
});

// Regression guard (code review): pages nested under dropdowns/anchors/versions — all valid Mintlify
// containers — must be found, or reorganizing docs.json makes every page beneath one look orphaned.
test("collectNavPages walks dropdowns, anchors, and versions containers too", () => {
  const config = {
    navigation: {
      dropdowns: [{ dropdown: "More", groups: [{ group: "G", pages: ["extra/one"] }] }],
      anchors: [{ anchor: "A", pages: ["extra/two"] }],
      versions: [{ version: "v2", tabs: [{ tab: "T", pages: ["v2/intro"] }] }],
    },
  };
  assert.deepEqual(collectNavPages(config).sort(), ["extra/one", "extra/two", "v2/intro"]);
});

test("collectNavPages ignores openapi groups and external href entries", () => {
  const config = {
    navigation: {
      tabs: [
        {
          tab: "API",
          groups: [
            { group: "Overview", pages: ["api/intro"] },
            { group: "Endpoints", openapi: "https://api.webhook.co/openapi.json" },
          ],
        },
      ],
    },
    navbar: { links: [{ label: "Dashboard", href: "https://app.webhook.co" }] },
  };
  assert.deepEqual(collectNavPages(config), ["api/intro"]);
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

test("parseFrontmatter reads title and description, quoted or bare", () => {
  const { data } = parseFrontmatter(
    [
      "---",
      'title: "Delete your account"',
      "description: How erasure works",
      "icon: trash",
      "---",
      "",
      "Body.",
    ].join("\n"),
  );
  assert.equal(data.title, "Delete your account");
  assert.equal(data.description, "How erasure works");
  assert.equal(data.icon, "trash");
});

test("parseFrontmatter returns empty data when the block is missing", () => {
  assert.deepEqual(parseFrontmatter("# Just a heading\n").data, {});
});

// ── extractInternalLinks: only root-relative targets, anchors/query stripped ───

test("extractInternalLinks finds markdown + component root-relative links only", () => {
  const mdx = [
    "See [profile](/help/account/profile) and [errors](/reference/errors#taxonomy).",
    'A card: <Card href="/help/billing/plans" title="Plans" />.',
    "External [site](https://example.com) and [mail](mailto:x@y.z) and a [rel](../other) are skipped.",
    "An [anchor-only](#section) is skipped.",
    "Query stripped: [q](/help/usage?tab=1).",
  ].join("\n");
  assert.deepEqual(extractInternalLinks(mdx).sort(), [
    "/help/account/profile",
    "/help/billing/plans",
    "/help/usage",
    "/reference/errors",
  ]);
});

// ── auditDocs integration over a real temp docs tree ──────────────────────────

async function scaffold(files) {
  const root = await mkdtemp(join(tmpdir(), "docs-nav-guard-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}
const page = (title = "T", desc = "D", body = "Body.") =>
  `---\ntitle: ${title}\ndescription: ${desc}\n---\n\n${body}\n`;

test("auditDocs passes a clean, fully-wired docs tree", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: {
        tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro", "help/a"] }] }],
      },
    }),
    "intro.mdx": page("Intro", "Welcome", "See [a](/help/a)."),
    "help/a.mdx": page("A", "The A page", "Back to [intro](/intro)."),
  });
  const { issues, pages } = await auditDocs({ docsRoot: root });
  assert.equal(pages, 2);
  assert.deepEqual(issues, []);
  await rm(root, { recursive: true, force: true });
});

test("auditDocs flags a dangling nav reference (page has no file)", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: {
        tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro", "help/missing"] }] }],
      },
    }),
    "intro.mdx": page(),
  });
  const { issues } = await auditDocs({ docsRoot: root });
  assert.ok(issues.some((i) => i.type === "dangling-nav" && i.page === "help/missing"));
  await rm(root, { recursive: true, force: true });
});

test("auditDocs flags an orphan mdx not referenced by nav", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": page(),
    "help/orphan.mdx": page(),
  });
  const { issues } = await auditDocs({ docsRoot: root });
  assert.ok(issues.some((i) => i.type === "orphan-page" && i.file === "help/orphan.mdx"));
  await rm(root, { recursive: true, force: true });
});

test("auditDocs flags missing required frontmatter", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": "---\ntitle: Only a title\n---\n\nNo description.\n",
  });
  const { issues } = await auditDocs({ docsRoot: root });
  assert.ok(
    issues.some(
      (i) =>
        i.type === "missing-frontmatter" && i.file === "intro.mdx" && /description/.test(i.detail),
    ),
  );
  await rm(root, { recursive: true, force: true });
});

test("auditDocs flags a broken internal link", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": page("Intro", "Welcome", "Dead [link](/help/does-not-exist)."),
  });
  const { issues } = await auditDocs({ docsRoot: root });
  assert.ok(
    issues.some(
      (i) =>
        i.type === "broken-link" && i.target === "/help/does-not-exist" && i.file === "intro.mdx",
    ),
  );
  await rm(root, { recursive: true, force: true });
});

test("auditDocs does NOT flag links into a generated namespace (openapi)", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: {
        tabs: [
          {
            tab: "Help",
            groups: [
              { group: "G", pages: ["intro"] },
              { group: "Endpoints", openapi: "https://api.webhook.co/openapi.json" },
            ],
          },
        ],
      },
    }),
    "intro.mdx": page(
      "Intro",
      "Welcome",
      "See the [create endpoint](/api-reference/create-endpoint) op.",
    ),
  });
  const { issues } = await auditDocs({ docsRoot: root, generatedPrefixes: ["api-reference"] });
  assert.deepEqual(issues, []);
  await rm(root, { recursive: true, force: true });
});

// Regression guard (code review): an image/download link is a file, not a page — it must not be
// reported as a broken page just because there's no `.mdx` behind it.
test("auditDocs does NOT flag an image/asset link as a broken page", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": page(
      "Intro",
      "Welcome",
      "![diagram](/images/flow.png) and a [spec](/files/x.pdf).",
    ),
  });
  const { issues } = await auditDocs({ docsRoot: root });
  assert.deepEqual(issues, []);
  await rm(root, { recursive: true, force: true });
});

// Regression guard (code review): Mintlify snippets/ are reusable fragments, not pages — no
// frontmatter, not in the nav. They must not be flagged as orphan/missing-frontmatter.
test("auditDocs ignores files under snippets/ (reusable fragments)", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": page(),
    "snippets/reused.mdx": "A shared fragment with no frontmatter and no nav entry.\n",
  });
  const { issues, pages } = await auditDocs({ docsRoot: root });
  assert.equal(pages, 1); // snippet not counted, not an orphan, not missing-frontmatter
  assert.deepEqual(issues, []);
  await rm(root, { recursive: true, force: true });
});

test("auditDocs ignores a README.md in the docs root (not a page)", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({
      navigation: { tabs: [{ tab: "Help", groups: [{ group: "G", pages: ["intro"] }] }] },
    }),
    "intro.mdx": page(),
    "README.md": "# apps/docs\n\nHow the docs are built. Not a page.\n",
  });
  const { issues, pages } = await auditDocs({ docsRoot: root });
  assert.equal(pages, 1); // README not counted, not an orphan, not missing-frontmatter
  assert.deepEqual(issues, []);
  await rm(root, { recursive: true, force: true });
});

test("auditDocs floor: throws when docs.json parses zero nav pages", async () => {
  const root = await scaffold({
    "docs.json": JSON.stringify({ navigation: { tabs: [] } }),
    "intro.mdx": page(),
  });
  await assert.rejects(() => auditDocs({ docsRoot: root }), /zero nav pages/i);
  await rm(root, { recursive: true, force: true });
});
