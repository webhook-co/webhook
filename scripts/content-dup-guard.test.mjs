import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  analyzePages,
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

test("runner exit-code contract: idle vs fail-closed (the behaviour CI actually invokes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdg-"));
  const write = (obj) => {
    const p = join(dir, "manifest.json");
    writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return p;
  };
  const boil = (n, h) => ({ id: n, name: n, header: h, text: boilerplate(n, h) });
  try {
    // manifest ABSENT → pre-pages idle → exit 0 (never a silent pass with real content)
    assert.equal(run(join(dir, "missing.json")), 0);
    // present-but-DEGENERATE → fail-closed floor → exit 1
    assert.equal(run(write({ pages: [] })), 1); // empty
    assert.equal(run(write({})), 1); // no `pages` key
    assert.equal(run(write("{ not json")), 1); // unreadable JSON
    assert.equal(run(write({ pages: [{ id: "x" }] })), 1); // malformed entry
    // FINDINGS → exit 1
    assert.equal(
      run(
        write({
          pages: [boil("GitHub", "x-hub-signature-256"), boil("Meta", "x-hub-signature-256")],
        }),
      ),
      1,
    ); // near-duplicate
    assert.equal(run(write({ pages: [{ id: "stub", name: "Acme", text: "too short" }] })), 1); // thin
    // HEALTHY estate → exit 0
    assert.equal(
      run(
        write({
          pages: [
            { id: "stripe", name: "Stripe", text: stripePage },
            boil("GitHub", "x-hub-signature-256"),
          ],
        }),
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

// ── Hand-authored pages: dup-checked, but not held to the GENERATED substance floor ───────────────
// The manifest carries the whole provider estate, not just what we generate, because the failure most
// worth catching is a NEW generated page duplicating an EXISTING hand-written one (calendly's recipe is
// byte-identical to stripe's, zoom's to slack's). But the thin-content floor exists to stop a GENERATED
// template from padding its way to a doorway page; a hand-authored page is a deliberate editorial
// length. So `generated: false` opts out of the WORD FLOOR only — never out of duplicate detection.
// Absence of the flag still means "generated", so nothing already in the manifest is silently exempted.

test("checkThinContent: an explicit generated:false page is exempt from the word floor", () => {
  const thin = checkThinContent([
    { id: "docs:handwritten", text: "Short but deliberate.", generated: false },
    { id: "docs:generated", text: "Short and generated." },
  ]);
  assert.deepEqual(
    thin.map((t) => t.id),
    ["docs:generated"],
    "only the generated page should be held to the floor",
  );
});

test("checkThinContent: a page with NO generated flag is still held to the floor (no silent exemption)", () => {
  const thin = checkThinContent([{ id: "docs:unflagged", text: "Too short." }]);
  assert.equal(thin.length, 1, "an unflagged entry must default to generated and be floor-checked");
});

test("findNearDuplicates: generated:false pages are STILL compared (the point of including them)", () => {
  const dups = findNearDuplicates([
    {
      id: "docs:handwritten",
      name: "Alpha",
      header: "x-a-sig",
      text: boilerplate("Alpha", "x-a-sig"),
      generated: false,
    },
    { id: "docs:generated", name: "Beta", header: "x-b-sig", text: boilerplate("Beta", "x-b-sig") },
  ]);
  assert.equal(
    dups.length,
    1,
    "a generated page duplicating a hand-written one must still be caught",
  );
});

test("run(): a thin hand-authored page does not fail the build, a thin generated one does", () => {
  const dir = mkdtempSync(join(tmpdir(), "dup-guard-exempt-"));
  try {
    const handOnly = join(dir, "hand.json");
    writeFileSync(
      handOnly,
      JSON.stringify({
        pages: [
          {
            id: "docs:hand",
            name: "A",
            header: "h",
            text: "Deliberately short.",
            generated: false,
          },
        ],
      }),
    );
    assert.equal(run(handOnly), 0, "an exempt thin page must not fail the guard");

    const genOnly = join(dir, "gen.json");
    writeFileSync(
      genOnly,
      JSON.stringify({
        pages: [{ id: "docs:gen", name: "A", header: "h", text: "Deliberately short." }],
      }),
    );
    assert.equal(run(genOnly), 1, "a thin GENERATED page must still fail the guard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
