// Tests for the nightly-rls failure classifier (#730).
//
// The fixtures below are TRIMMED VERBATIM EXCERPTS of real runs, not invented shapes:
//   - GREEN_WITH_TOLERATED_LOGS + FAILED_717 reproduce run 29819273539, whose auto-filed issue
//     (#717) led with two `permission denied for table …` lines that had nothing to do with the
//     failure — they come from the tolerated `auth.sweep.skipped` log that green runs emit too.
//   - The banner/box-drawing characters are vitest 4's actual output (U+23AF runs), after ANSI strip.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTENTION,
  NON_TRANSIENT,
  TRANSIENT,
  classify,
  failureSection,
  signatureLines,
  stripAnsi,
} from "./nightly-rls-classify.mjs";

// The tolerated noise a GREEN run emits. Nothing here is a failure.
const GREEN_WITH_TOLERATED_LOGS = `
 ✓ test/rls.test.ts (179 tests) 120054ms
{"message":"auth.sweep.skipped","table":"auth_refresh_token","error":"permission denied for table auth_refresh_token"}
{"message":"auth.sweep.skipped","table":"auth_session_exchange","error":"permission denied for table auth_session_exchange"}
 ✓ test/activation-rollup.test.ts (12 tests) 4200ms

 Test Files  100 passed (100)
      Tests  1532 passed (1532)
`;

// Run 29819273539 — the #717 failure, with the tolerated noise interleaved exactly as it was.
const FAILED_717 = `
 ✓ test/rls.test.ts (179 tests) 120054ms
{"message":"auth.sweep.skipped","table":"auth_refresh_token","error":"permission denied for table auth_refresh_token"}
{"message":"auth.sweep.skipped","table":"auth_session_exchange","error":"permission denied for table auth_session_exchange"}
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/activation-rollup.test.ts > activation_weekly_review (SECURITY DEFINER, aggregate-only) > cohort funnel
PostgresError: permission denied for function activation_weekly_review
 ❯ ErrorResponse ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:815:30
 ❯ test/activation-rollup.test.ts:288:6

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/activation-rollup.test.ts > readActivationWeeklyReview (typed reader) > maps rows
PostgresError: permission denied for function activation_weekly_review
 ❯ readActivationWeeklyReview src/activation-review.ts:51:4

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed | 99 passed (100)
      Tests  2 failed | 1530 passed (1532)
`;

const FAILED_TRANSIENT = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/index-usage.test.ts > gin write amplification
Error: Test timed out in 120000ms.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 99 passed (100)
`;

// Contention: another consumer rotated the cluster-global role passwords mid-run.
const FAILED_CONTENTION_28P01 = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/rls.test.ts > cross-org isolation
PostgresError: password authentication failed for user "webhook_app"
 ❯ ErrorResponse ../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:815:30

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 99 passed (100)
`;

// Contention: the globalSetup sweep dropped a database out from under a running suite.
const FAILED_CONTENTION_3D000 = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/audit-append.test.ts > appends
PostgresError: database "webhook_test_9f2c1ab0de44" does not exist

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 99 passed (100)
`;

// The suite died before vitest ever produced a Failed Tests section (setup/infra fault).
const DIED_IN_SETUP = `
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: Cannot find module 'postgres' imported from test/global-setup.ts
`;

// ── stripAnsi ─────────────────────────────────────────────────────────────────────────────────
test("stripAnsi removes the colour codes vitest emits, leaving the box-drawing intact", () => {
  const raw = "[31m⎯⎯⎯[39m[1m[41m Failed Tests 2 [49m[22m";
  assert.equal(stripAnsi(raw), "⎯⎯⎯ Failed Tests 2 ");
});

// ── §1 the signature must be scoped to FAILING tests ──────────────────────────────────────────
test("the signature does NOT carry lines emitted by passing tests (the #717 defect)", () => {
  const sig = signatureLines(FAILED_717);
  const joined = sig.join("\n");
  assert.ok(
    !joined.includes("auth_refresh_token"),
    `tolerated auth.sweep.skipped noise leaked into the signature:\n${joined}`,
  );
  assert.ok(!joined.includes("auth_session_exchange"), joined);
});

test("the signature DOES carry the real failure", () => {
  const joined = signatureLines(FAILED_717).join("\n");
  assert.match(joined, /permission denied for function activation_weekly_review/);
  assert.match(joined, /FAIL {2}test\/activation-rollup\.test\.ts/);
});

test("a fully green log yields no signature at all", () => {
  assert.deepEqual(signatureLines(GREEN_WITH_TOLERATED_LOGS), []);
});

test("failureSection bounds the scrape between the banner and the Test Files summary", () => {
  const section = failureSection(FAILED_717);
  assert.equal(section.scoped, true);
  assert.ok(section.text.includes("permission denied for function"));
  assert.ok(!section.text.includes("auth.sweep.skipped"));
  assert.ok(!section.text.includes("Test Files"));
});

test("with no Failed Tests section it falls back to the whole log, and SAYS it is unscoped", () => {
  const section = failureSection(DIED_IN_SETUP);
  assert.equal(section.scoped, false);
  const { signature, classification } = classify({ log: DIED_IN_SETUP, attempt: 1 });
  assert.match(signature, /Cannot find module/);
  // The reader must not mistake an unscoped scrape for a precise one.
  assert.match(signature, /whole log/i);
  assert.equal(classification.startsWith(NON_TRANSIENT), true);
});

test("the signature is deduplicated and bounded", () => {
  const repeated = `⎯⎯⎯ Failed Tests 40 ⎯⎯⎯\n${Array.from(
    { length: 40 },
    (_, i) =>
      ` FAIL  test/f${i}.test.ts > t\nPostgresError: permission denied for function fn_${i}`,
  ).join("\n")}\n Test Files  40 failed (100)`;
  const sig = signatureLines(repeated);
  assert.ok(sig.length <= 8, `expected a bounded signature, got ${sig.length}`);
  assert.equal(new Set(sig).size, sig.length, "signature must be deduplicated");
});

// ── §2 the CONTENTION bucket ──────────────────────────────────────────────────────────────────
test("a 28P01 on a webhook_* role is CONTENTION, not a certified real bug", () => {
  const { classification } = classify({ log: FAILED_CONTENTION_28P01, attempt: 1 });
  assert.equal(classification.startsWith(CONTENTION), true, classification);
  assert.match(classification, /another consumer touched the branch/i);
  assert.ok(!classification.includes(NON_TRANSIENT), classification);
});

test("a 3D000 on a webhook_test_* database is CONTENTION", () => {
  const { classification } = classify({ log: FAILED_CONTENTION_3D000, attempt: 1 });
  assert.equal(classification.startsWith(CONTENTION), true, classification);
});

test("a 28P01 on a NON-webhook role is not silently excused as contention", () => {
  const log = FAILED_CONTENTION_28P01.replace("webhook_app", "some_other_role");
  const { classification } = classify({ log, attempt: 1 });
  assert.ok(!classification.startsWith(CONTENTION), classification);
});

test("a database-not-found for a NON-test database is not excused as contention", () => {
  const log = FAILED_CONTENTION_3D000.replace("webhook_test_9f2c1ab0de44", "webhook_prod");
  const { classification } = classify({ log, attempt: 1 });
  assert.ok(!classification.startsWith(CONTENTION), classification);
});

test("contention detected only in PASSING output does not reclassify a real failure", () => {
  // The tolerated-noise defect again, one layer up: a 28P01 logged by a negative-path test that
  // PASSED must not turn a genuine deterministic failure into 'CONTENTION'.
  const log = FAILED_717.replace(
    '{"message":"auth.sweep.skipped","table":"auth_refresh_token","error":"permission denied for table auth_refresh_token"}',
    'password authentication failed for user "webhook_app"',
  );
  const { classification } = classify({ log, attempt: 1 });
  assert.equal(classification.startsWith(NON_TRANSIENT), true, classification);
});

// ── the transient / non-transient buckets still work ──────────────────────────────────────────
test("a timeout is TRANSIENT and retryable on the first attempt", () => {
  const { classification, retry } = classify({ log: FAILED_TRANSIENT, attempt: 1 });
  assert.equal(classification.startsWith(TRANSIENT), true, classification);
  assert.equal(retry, true);
});

test("a deterministic failure is NON-TRANSIENT and is NOT retried", () => {
  const { classification, retry } = classify({ log: FAILED_717, attempt: 1 });
  assert.equal(classification.startsWith(NON_TRANSIENT), true, classification);
  assert.equal(retry, false);
});

test("CONTENTION is reported rather than re-run (a 4h suite must not double on a race)", () => {
  const { retry } = classify({ log: FAILED_CONTENTION_28P01, attempt: 1 });
  assert.equal(retry, false);
});

// ── §3 attempt 2 must be re-inspected, not labelled from attempt 1 ────────────────────────────
test("attempt 2 that fails deterministically is NOT labelled 'transient-looking'", () => {
  const { classification, retry } = classify({ log: FAILED_717, attempt: 2 });
  assert.ok(
    !/transient-looking/i.test(classification),
    `attempt 2 was re-inspected as deterministic but still read: ${classification}`,
  );
  assert.equal(classification.startsWith(NON_TRANSIENT), true, classification);
  assert.equal(retry, false, "there is no third attempt");
});

test("attempt 2 that fails transiently again says BOTH attempts were transient", () => {
  const { classification, retry } = classify({ log: FAILED_TRANSIENT, attempt: 2 });
  assert.equal(classification.startsWith(TRANSIENT), true, classification);
  assert.match(classification, /both attempts/i);
  assert.equal(retry, false);
});

test("attempt 2 never asks for another retry, whatever the bucket", () => {
  for (const log of [FAILED_TRANSIENT, FAILED_717, FAILED_CONTENTION_28P01, DIED_IN_SETUP]) {
    assert.equal(classify({ log, attempt: 2 }).retry, false);
  }
});

// ── output shape the workflow depends on ──────────────────────────────────────────────────────
test("classify never returns an empty classification, even for an empty log", () => {
  for (const log of ["", "\n", undefined]) {
    const { classification } = classify({ log, attempt: 1 });
    assert.ok(classification.length > 0);
  }
});

test("the signature never carries a raw connection string or password", () => {
  const leaky = `⎯⎯⎯ Failed Tests 1 ⎯⎯⎯
 FAIL  test/x.test.ts > t
PostgresError: could not connect to postgres://neondb_owner:sup3rs3cret@ep-x.neon.tech/neondb
 Test Files  1 failed (1)`;
  const sig = signatureLines(leaky).join("\n");
  assert.ok(!sig.includes("sup3rs3cret"), sig);
  assert.ok(!sig.includes("postgres://"), sig);
});

// ── the assertion that actually blocks the bug: a REAL run's log ───────────────────────────────
// Everything above pins the brain's edges against hand-written shapes. This runs the whole
// classifier over a committed excerpt of run 29819273539 — the run whose auto-filed issue (#717)
// led with two irrelevant `permission denied for table …` lines. It is the only test here that
// would have caught the ANSI-stripping defect against the `^[` form `gh run view --log` returns.

const ESC = String.fromCharCode(27);
const REAL_717_LOG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nightly-rls-717.log.txt"),
  "utf8",
);

test("the committed fixture is the real thing (a fixture that lost its escapes proves nothing)", () => {
  assert.ok(REAL_717_LOG.includes(ESC), "fixture must retain real ANSI escape bytes");
  assert.match(REAL_717_LOG, /Failed Tests 2/);
  assert.match(REAL_717_LOG, /auth\.sweep\.skipped/, "fixture must retain the tolerated noise");
});

test("on the REAL #717 log the signature drops the noise and keeps the actual failure", () => {
  const { signature } = classify({ log: REAL_717_LOG, attempt: 1 });
  assert.match(signature, /permission denied for function activation_weekly_review/);
  // The two lines the old scrape led with. Both come from a PASSING test.
  assert.ok(!signature.includes("auth_refresh_token"), signature);
  assert.ok(!signature.includes("auth_session_exchange"), signature);
  // The old scrape also lifted the workflow's OWN echoed grep pattern out of the run log.
  assert.ok(!signature.includes("[^\\"), signature);
  assert.ok(!/whole log/i.test(signature), "the real log HAS a Failed Tests section — scope it");
});

test("the REAL #717 log classifies as NON-TRANSIENT and is not re-run", () => {
  const { classification, retry } = classify({ log: REAL_717_LOG, attempt: 1 });
  // CONNECT_TIMEOUT appears in this log — in passing output and in the workflow's echoed regex.
  // Unscoped, that made a deterministic failure look transient and asked for a second 4-hour run.
  assert.equal(classification.startsWith(NON_TRANSIENT), true, classification);
  assert.equal(retry, false);
});
