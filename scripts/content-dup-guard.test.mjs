import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  analyzePages,
  checkCoverage,
  discoverFragments,
  loadManifests,
  checkThinContent,
  findNearDuplicates,
  jaccard,
  NEAR_DUP_JACCARD,
  normalize,
  run,
  wordShingles,
} from "./content-dup-guard.mjs";

// A ~180-word boilerplate "verify {provider} webhooks" template where ONLY the brand name + header
// token vary — the exact thin-content risk the registry's raw-body cluster creates (github ≈ meta ≈
// bitbucket all compile to the same recipe). Two instances MUST be flagged as near-duplicates.
const boilerplate = (name, header) =>
  `Verify ${name} webhook signatures with webhook.co. ${name} signs every webhook it sends you with an
  HMAC-SHA256 over the exact raw request body, and delivers the resulting signature hex-encoded in the
  ${header} header. To verify a ${name} webhook you register the ${name} signing secret on your endpoint
  and webhook.co checks the signature against the captured bytes for you, then stamps each event with a
  verification state you can read from the dashboard, the API, or the command line. First, get the ${name}
  signing secret from the ${name} dashboard and copy it. Then register it on your endpoint using the CLI,
  the API, or the TypeScript SDK. Once registered, every inbound ${name} request is verified automatically
  and you never touch the crypto yourself. A request whose signature does not match the recomputed HMAC is
  marked failed rather than accepted, so a forged or tampered payload never reaches your handler. Because
  ${name} signs the raw body verbatim, there is no timestamp and no replay window to configure. Send a
  test ${name} event and confirm it shows as verified in your event list to finish the setup.`;

// A genuinely DIFFERENT page: a timestamped-HMAC provider with replay-window content and distinct prose.
const stripePage = `Testing Stripe webhooks locally is the fastest way to build a reliable Stripe
  integration. Stripe signs each event with an HMAC-SHA256 over a timestamped message — the unix
  timestamp, a literal dot, and the raw body — and carries it in the Stripe-Signature header as a
  comma-separated t and v1 pair. Because the timestamp is signed, webhook.co enforces a five-minute
  replay window: an event whose timestamp is older than the tolerance is rejected instead of being
  accepted as a possible replay. Install the webhook.co CLI, run the listen command to forward captured
  Stripe events straight to your localhost port, and replay any event as many times as you need while you
  debug your handler. During a secret roll the Stripe-Signature header can carry several v1 values at
  once, and any one of them matching verifies, so rotating your endpoint secret never drops a delivery.
  Point your Stripe dashboard webhook endpoint at the capture URL, trigger a test event, and watch it
  arrive, verify, and forward — no tunnels, no redeploys, no guesswork about what Stripe actually sent.`;

// A third distinct healthy page, so a coverage fixture can hold two docs pages that are neither
// thin nor near-duplicates of each other.
const zendeskPage = `Zendesk sends a signed webhook for every ticket event you subscribe to, and the
  signature is an HMAC-SHA256 over the raw request body carried in a dedicated header alongside a
  separate timestamp header that is itself part of the signed material. Register the secret shown in
  the admin centre and each delivery is checked against the bytes captured at the ingest URL. Because
  the timestamp is signed it cannot be moved without invalidating the digest, which is what makes a
  freshness window meaningful rather than decorative. Ticket events arrive in bursts when an agent
  performs a bulk update, so plan for many deliveries describing one human action and deduplicate on
  the identifier inside the payload rather than on arrival order. The admin centre shows the secret
  once when the webhook is created and never again, so capture it at creation time and store it with
  your other credentials before you navigate away from that screen entirely.`;

test("normalize + shingles: basic invariants", () => {
  assert.equal(normalize("Hello,  WORLD!!"), "hello world");
  assert.equal(wordShingles("a b c d e f", 5).size, 2); // [a..e], [b..f]
  assert.equal(wordShingles("", 5).size, 0);
  assert.equal(
    jaccard(wordShingles("one two three four five"), wordShingles("one two three four five")),
    1,
  );
});

test("catches a near-duplicate boilerplate pair (github ≈ meta) even though the brand name is swapped ~10x", () => {
  const pages = [
    {
      id: "github",
      name: "GitHub",
      header: "x-hub-signature-256",
      text: boilerplate("GitHub", "x-hub-signature-256"),
    },
    {
      id: "meta",
      name: "Meta",
      header: "x-hub-signature-256",
      text: boilerplate("Meta", "x-hub-signature-256"),
    },
  ];
  const dups = findNearDuplicates(pages);
  assert.equal(dups.length, 1);
  assert.deepEqual([dups[0].a, dups[0].b].sort(), ["github", "meta"]);
  assert.ok(
    dups[0].score >= NEAR_DUP_JACCARD,
    `score ${dups[0].score} must be ≥ ${NEAR_DUP_JACCARD}`,
  );
});

test("catches same-recipe-different-header near-dups (github x-hub-signature-256 ≈ bitbucket x-hub-signature)", () => {
  const pages = [
    {
      id: "github",
      name: "GitHub",
      header: "x-hub-signature-256",
      text: boilerplate("GitHub", "x-hub-signature-256"),
    },
    {
      id: "bitbucket",
      name: "Bitbucket",
      header: "x-hub-signature",
      text: boilerplate("Bitbucket", "x-hub-signature"),
    },
  ];
  assert.equal(findNearDuplicates(pages).length, 1);
});

test("does NOT flag two genuinely distinct pages (raw-body github vs timestamped stripe)", () => {
  const pages = [
    {
      id: "github",
      name: "GitHub",
      header: "x-hub-signature-256",
      text: boilerplate("GitHub", "x-hub-signature-256"),
    },
    { id: "stripe", name: "Stripe", header: "stripe-signature", text: stripePage },
  ];
  assert.equal(findNearDuplicates(pages).length, 0);
});

test("mutation test: a real page with a SINGLE token changed is still caught as a near-dup", () => {
  const a = { id: "a", name: "Stripe", text: stripePage };
  const b = { id: "b", name: "Stripe", text: stripePage.replace("fastest", "quickest") };
  assert.equal(findNearDuplicates([a, b]).length, 1);
});

test("flags thin content via the WORD floor (a short stub)", () => {
  const thin = checkThinContent([
    {
      id: "stub",
      name: "Acme",
      text: "Verify Acme webhook signatures. HMAC-SHA256 over the raw body.",
    },
    { id: "rich", name: "Stripe", text: stripePage },
  ]);
  assert.deepEqual(
    thin.map((t) => t.id),
    ["stub"],
  );
});

test("flags thin content via the SHINGLE floor independently of the word floor", () => {
  // A LONG page (clears MIN_BODY_WORDS) that is the SAME boilerplate phrase repeated + a brand name —
  // exactly the doorway page the word floor alone would miss. After neutralizing the brand, its unique
  // 5-gram count collapses below MIN_UNIQUE_SHINGLES. Fails if neutralization is dropped from
  // pageShingles OR the shingle floor is ignored (the regression the guard exists to catch).
  const phrase =
    "Verify Acme webhook signatures with webhook co using the Acme signing secret today. ";
  const padded = phrase.repeat(16); // ~200 words of near-zero unique substance
  const thin = checkThinContent([{ id: "padded", name: "Acme", text: padded }]);
  assert.equal(thin.length, 1, "the padded boilerplate page must be flagged thin");
  assert.ok(thin[0].wordCount >= 150, `wordCount ${thin[0].wordCount} must CLEAR the word floor`);
  assert.ok(
    thin[0].shingleCount < 40,
    `shingleCount ${thin[0].shingleCount} must FAIL the shingle floor`,
  );
});

test("does NOT flag a diverse page that clears BOTH floors", () => {
  const thin = checkThinContent([{ id: "stripe", name: "Stripe", text: stripePage }]);
  assert.equal(thin.length, 0);
});

test("runner exit-code contract: fail-closed everywhere (the behaviour CI actually invokes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdg-"));
  const write = (obj) => {
    const p = join(dir, "manifest.json");
    writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return p;
  };
  const boil = (n, h) => ({
    id: n,
    host: "docs",
    path: `/providers/${n}`,
    name: n,
    header: h,
    text: boilerplate(n, h),
  });
  try {
    // manifest ABSENT → exit 1. Previously this was an "idle" pass for the pre-pages state; both
    // fragments are committed now, so an absent one means a host was dropped, not that none exists.
    assert.equal(run(join(dir, "missing.json"), false), 1);
    // present-but-DEGENERATE → fail-closed floor → exit 1
    assert.equal(run(write({ pages: [] }), false), 1); // empty
    assert.equal(run(write({}), false), 1); // no `pages` key
    assert.equal(run(write("{ not json"), false), 1); // unreadable JSON
    assert.equal(run(write({ pages: [{ id: "x" }] }), false), 1); // malformed entry (no host/path)
    // FINDINGS → exit 1
    assert.equal(
      run(
        write({
          pages: [boil("GitHub", "x-hub-signature-256"), boil("Meta", "x-hub-signature-256")],
        }),
        false,
      ),
      1,
    ); // near-duplicate
    assert.equal(
      run(
        write({
          pages: [
            { id: "stub", host: "docs", path: "/providers/stub", name: "Acme", text: "too short" },
          ],
        }),
        false,
      ),
      1,
    ); // thin
    // HEALTHY estate → exit 0
    assert.equal(
      run(
        write({
          pages: [
            {
              id: "stripe",
              host: "docs",
              path: "/providers/stripe",
              name: "Stripe",
              text: stripePage,
            },
            boil("GitHub", "x-hub-signature-256"),
          ],
        }),
        false,
      ),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FLOOR: analyzePages refuses to report clean on an empty or non-array page set", () => {
  assert.throws(() => analyzePages([]), /fail-closed floor/);
  assert.throws(() => analyzePages(null), /fail-closed floor/);
  assert.throws(() => analyzePages(undefined), /fail-closed floor/);
});

test("FLOOR: analyzePages rejects a malformed page entry", () => {
  assert.throws(() => analyzePages([{ id: "x" }]), /malformed page entry/);
  assert.throws(() => analyzePages([{ text: "y" }]), /malformed page entry/);
});

test("analyzePages on a healthy estate returns no findings", () => {
  const result = analyzePages([
    { id: "stripe", text: stripePage },
    { id: "github", text: boilerplate("GitHub", "x-hub-signature-256") },
  ]);
  assert.equal(result.thin.length, 0);
  assert.equal(result.nearDuplicates.length, 0);
});

// ── Coverage across the whole shipped estate ─────────────────────────────────────
// The guard's reason for existing is CROSS-HOST dedup (docs `/providers/{slug}` vs www
// `/test/{slug}`). Each host emits its own fragment; the guard must merge them into ONE analysis
// set, or a cross-host pair is never a pair and the check silently never runs.

test("merges every declared fragment into ONE analysis set, so cross-host pairs are compared", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-merge-"));
  try {
    const docs = join(dir, "docs.json");
    const www = join(dir, "www.json");
    const page = (id, host, path) => ({
      id,
      host,
      path,
      name: "Acme",
      text: boilerplate("Acme", "x-acme-signature"),
    });
    writeFileSync(docs, JSON.stringify({ pages: [page("docs:acme", "docs", "/providers/acme")] }));
    writeFileSync(www, JSON.stringify({ pages: [page("www:acme", "www", "/test/acme")] }));

    // Each fragment ALONE is clean: one page, no pair to compare, above the floor.
    assert.equal(run([docs], false), 0, "a single-page fragment alone must be clean");
    assert.equal(run([www], false), 0, "a single-page fragment alone must be clean");

    // Merged, the identical prose across hosts is a near-duplicate. This pair exists ONLY if the
    // fragments are analyzed together — it is the exact check that has never run.
    assert.equal(run([docs, www], false), 1, "a cross-fragment near-duplicate pair must fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FLOOR: a declared fragment that is missing FAILS — it never reads as idle coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-absent-"));
  try {
    const docs = join(dir, "docs.json");
    writeFileSync(
      docs,
      JSON.stringify({
        pages: [
          {
            id: "docs:acme",
            host: "docs",
            path: "/providers/acme",
            name: "Acme",
            text: boilerplate("Acme", "x-acme-signature"),
          },
        ],
      }),
    );
    // Deleting one host's fragment must not silently drop that host from the estate.
    assert.equal(run([docs, join(dir, "absent.json")], false), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FLOOR: the same page id in two fragments FAILS (a collision would mask a page)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-collide-"));
  try {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    // The two entries share an id but hold GENUINELY DIFFERENT prose — each clears the floor and the
    // pair is nowhere near the dup threshold. So the ONLY thing that can fail this run is the
    // collision check itself; if it is removed, the merged set is otherwise perfectly healthy.
    writeFileSync(
      a,
      JSON.stringify({
        pages: [
          {
            id: "docs:acme",
            host: "docs",
            path: "/providers/acme",
            name: "Acme",
            text: stripePage,
          },
        ],
      }),
    );
    writeFileSync(
      b,
      JSON.stringify({
        pages: [
          {
            id: "docs:acme",
            host: "docs",
            path: "/providers/acme",
            name: "Acme",
            header: "x-acme-signature",
            text: boilerplate("Acme", "x-acme-signature"),
          },
        ],
      }),
    );
    // Sanity: each fragment alone is a healthy estate, so the shared id is what fails the merged
    // run — not the content, and not the floor.
    assert.equal(run([a], false), 0, "fragment a alone must be healthy");
    assert.equal(run([b], false), 0, "fragment b alone must be healthy");
    assert.equal(run([a, b], false), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The fragment list must not itself be a hand-maintained inventory ─────────────
// Scoping the manifest to one generator's output is what made the original gap self-concealing.
// A hardcoded list of fragments reproduces that defect one level up: a new estate emits a fragment,
// nobody edits the array, and the guard reports "clean" over a set that silently excludes it.

test("discovers every committed fragment from disk, with a floor (never a hand-maintained list)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-discover-"));
  try {
    writeFileSync(join(dir, "a-pages.json"), "{}");
    assert.throws(
      () => discoverFragments(dir),
      /at least/,
      "one fragment must not satisfy the floor",
    );
    writeFileSync(join(dir, "b-pages.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.deepEqual(
      discoverFragments(dir).map((p) => p.split("/").pop()),
      ["a-pages.json", "b-pages.json"],
      "every *-pages.json is picked up, and nothing else is",
    );
    // A third estate needs no code change to be covered.
    writeFileSync(join(dir, "vs-pages.json"), "{}");
    assert.equal(discoverFragments(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Coverage is checked where the FLOOR is checked ───────────────────────────────
// The completeness assertions in the generators' own test files run under `pnpm test`; the floor
// runs under `pnpm lint`. A fragment holding 3 of 20 pages passes every quantity check the guard
// has and prints "all above the substance floor". So the guard verifies its own input against the
// shipped estate on disk — an inventory neither generator consults.

test("fails when a page that ships on disk is absent from the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-cover-"));
  try {
    const docsDir = join(dir, "providers");
    const wwwDir = join(dir, "test");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(join(wwwDir, "acme"), { recursive: true });
    writeFileSync(join(wwwDir, "acme", "page.tsx"), "export default () => null;");
    writeFileSync(join(docsDir, "stripe.mdx"), "x");
    writeFileSync(join(docsDir, "square.mdx"), "x");

    const pages = [
      { id: "docs:stripe", host: "docs", path: "/providers/stripe", text: stripePage },
      { id: "www:acme", host: "www", path: "/test/acme", text: stripePage },
    ];
    // square.mdx ships but is not in the manifest.
    assert.deepEqual(checkCoverage(pages, { docsDir, wwwTestDir: wwwDir }), ["docs:square"]);

    // A `.md` page is a page too — the nav guard treats it as one, so the glob must not miss it.
    writeFileSync(join(docsDir, "eventbridge.md"), "x");
    assert.deepEqual(checkCoverage(pages, { docsDir, wwwTestDir: wwwDir }).sort(), [
      "docs:eventbridge",
      "docs:square",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FLOOR: coverage refuses to pass over an empty inventory", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-cover-floor-"));
  try {
    const docsDir = join(dir, "providers");
    const wwwDir = join(dir, "test");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(wwwDir, { recursive: true });
    const pages = [{ id: "docs:x", host: "docs", path: "/providers/x", text: stripePage }];
    assert.throws(() => checkCoverage(pages, { docsDir, wwwTestDir: wwwDir }), /refusing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FLOOR: a fragment entry missing host/path fails with a legible message, not a TypeError", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-shape-"));
  try {
    const a = join(dir, "a-pages.json");
    const b = join(dir, "b-pages.json");
    writeFileSync(
      b,
      JSON.stringify({
        pages: [
          { id: "www:x", host: "www", path: "/test/x", name: "X", text: boilerplate("X", "x-h") },
        ],
      }),
    );
    const write = (page) => {
      writeFileSync(a, JSON.stringify({ pages: [page] }));
      return [a, b];
    };
    assert.throws(
      () => loadManifests(write({ id: "docs:x", host: "docs", text: stripePage })),
      /malformed page entry/,
      "an entry with no `path` must name itself, not blow up on a property read",
    );
    assert.throws(
      () => loadManifests(write({ id: "docs:x", path: "/providers/x", text: stripePage })),
      /malformed page entry/,
      "an entry with no `host` must name itself",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The coverage check must be reachable THROUGH `run()`, not only by calling checkCoverage directly.
// Without these, deleting the coverage branch from run() leaves the whole suite green — the branch
// that makes `pnpm lint` fail on a truncated manifest would have a mutation score of zero.
test("run() applies coverage: a complete estate passes, a truncated manifest fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "dupguard-runcov-"));
  try {
    const docsDir = join(dir, "providers");
    const wwwTestDir = join(dir, "test");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(join(wwwTestDir, "acme"), { recursive: true });
    writeFileSync(join(wwwTestDir, "acme", "page.tsx"), "export default () => null;");
    writeFileSync(join(docsDir, "stripe.mdx"), "x");
    writeFileSync(join(docsDir, "square.mdx"), "x");

    const frag = join(dir, "a-pages.json");
    const write = (pages) => {
      writeFileSync(frag, JSON.stringify({ pages }));
      return [frag];
    };
    const docsPage = (slug, text) => ({
      id: `docs:${slug}`,
      host: "docs",
      path: `/providers/${slug}`,
      name: slug,
      text,
    });
    const wwwPage = {
      id: "www:acme",
      host: "www",
      path: "/test/acme",
      name: "Acme",
      text: boilerplate("Acme", "x-acme-signature"),
    };

    // Complete: every page on disk has an entry.
    assert.equal(
      run(write([docsPage("stripe", stripePage), docsPage("square", zendeskPage), wwwPage]), {
        docsDir,
        wwwTestDir,
      }),
      0,
      "a complete estate must pass through run()",
    );

    // Truncated: square.mdx ships but is absent. Nothing else about the estate changed — it is
    // still clean on the floor and on near-duplicates, so ONLY coverage can fail this.
    assert.equal(
      run(write([docsPage("stripe", stripePage), wwwPage]), { docsDir, wwwTestDir }),
      1,
      "a page that ships but is absent from the manifest must fail through run()",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
