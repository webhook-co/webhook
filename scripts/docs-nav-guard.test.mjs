import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectNavPages,
  parseFrontmatter,
  extractInternalLinks,
  auditDocs,
  collectRepoLinkIssues,
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

// ── collectRepoLinkIssues: the docs chrome must link the REPO, not the org ─────
//
// THE DEFECT THIS EXISTS FOR: `docs.json` shipped with `footer.socials.github` pointing at
// `https://github.com/webhook-co` — the ORG page. An org page is a repo list; it carries no star
// button, no README, no topics. Every reader who followed the only GitHub link in the docs landed
// somewhere they could not star, and docs is the only surface with measured search impressions.
//
// A string equality test in the guard would be worthless here — it has to catch the SHAPE of the
// mistake (an org-level URL) rather than one known-bad value, because the next person to add a
// GitHub link to the navbar can make the identical mistake with a different field.

test("collectRepoLinkIssues flags an org-level GitHub URL in the footer socials", () => {
  const issues = collectRepoLinkIssues({
    footer: { socials: { github: "https://github.com/webhook-co" } },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "github-org-link");
  assert.match(issues[0].detail, /webhook-co/);
});

test("collectRepoLinkIssues flags an org-level GitHub URL in a navbar link", () => {
  const issues = collectRepoLinkIssues({
    navbar: { links: [{ type: "github", href: "https://github.com/webhook-co" }] },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "github-org-link");
});

test("collectRepoLinkIssues accepts a repo-level URL anywhere in the chrome", () => {
  const issues = collectRepoLinkIssues({
    navbar: {
      links: [
        { type: "github", href: "https://github.com/webhook-co/webhook" },
        { label: "Dashboard", href: "https://app.webhook.co" },
      ],
    },
    footer: { socials: { github: "https://github.com/webhook-co/webhook" } },
  });
  assert.deepEqual(issues, []);
});

test("collectRepoLinkIssues finds GitHub links nested anywhere, not just the two known fields", () => {
  // The guard must not enumerate a curated list of places a link may hide — a curated list only ever
  // reports on the list. It walks the config.
  const issues = collectRepoLinkIssues({
    navigation: { anchors: [{ anchor: "Source", href: "https://github.com/webhook-co" }] },
  });
  assert.equal(issues.length, 1);
});

test("collectRepoLinkIssues ignores third-party GitHub URLs", () => {
  // Linking someone else's repo or org is normal and is not this guard's business.
  const issues = collectRepoLinkIssues({
    footer: { socials: { github: "https://github.com/standard-webhooks/standard-webhooks" } },
  });
  assert.deepEqual(issues, []);
});

test("collectRepoLinkIssues has a zero-input floor — an empty config yields no false pass", () => {
  // A guard that reports "clean" on nothing is a guard that cannot fail. `null` means "nothing was
  // parsed", which is a different answer from "nothing was wrong".
  assert.throws(() => collectRepoLinkIssues(null), /no config/i);
});

test("collectRepoLinkIssues exempts seo.organization.sameAs — identity, not a clickable link", () => {
  // The org profile is the CORRECT node for an Organization's sameAs: the entity being described is
  // the organisation, not one of its repositories. apps/www's JSON-LD asserts the same URL.
  const issues = collectRepoLinkIssues({
    seo: { organization: { sameAs: ["https://github.com/webhook-co"] } },
  });
  assert.deepEqual(issues, []);
});

test("the seo exemption is narrow — an org link in the chrome still fails", () => {
  // Keyed on what the guard MEANS (clickable links), not on "the field that tripped it". If the
  // exemption leaked, this is the case that would silently start passing.
  const issues = collectRepoLinkIssues({
    seo: { organization: { sameAs: ["https://github.com/webhook-co"] } },
    navbar: { links: [{ type: "github", href: "https://github.com/webhook-co" }] },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].href, "https://github.com/webhook-co");
});

test("the real docs.json links the repo, not the org", async () => {
  // The end-to-end assertion: whatever the shipped config says today, it must pass its own guard.
  const config = JSON.parse(
    await readFile(new URL("../apps/docs/docs.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(collectRepoLinkIssues(config), []);
  // Non-vacuous: prove the chrome actually carries a GitHub link at all, so the check above is not
  // passing because there was nothing to check.
  assert.match(JSON.stringify(config.navbar), /github\.com\/webhook-co\/webhook/);
});
