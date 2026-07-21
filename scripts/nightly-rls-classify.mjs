#!/usr/bin/env node
// Classify a nightly-rls run's failure and build the signature the auto-filed issue leads with.
//
// This used to be a shell function inlined in .github/workflows/nightly-rls.yml. It moved here so it
// can be tested against REAL logs (scripts/nightly-rls-classify.test.mjs uses trimmed excerpts of
// actual runs), because both of its defects were the kind only a fixture catches:
//
//   1. THE SIGNATURE WAS SCRAPED FROM THE WHOLE LOG, so lines emitted by PASSING tests were
//      published as the failure signature. #717's auto-filed body led with
//        permission denied for table auth_refresh_token
//        permission denied for table auth_session_exchange
//      Neither had anything to do with the failure — they come from the tolerated
//      `auth.sweep.skipped` log that GREEN runs emit too. The real signature was a single
//      `permission denied for function …` further down. A human (and an agent) triaging that issue
//      was actively misled by its own alerting.
//
//   2. THERE WAS NO CONTENTION BUCKET. The classifier had exactly two outcomes — transient (retry)
//      or NON-TRANSIENT — and the issue template told the reader "a NON-TRANSIENT verdict means a
//      real bug". But if anything else touches the branch concurrently the suite can die on a
//      `28P01 password authentication failed` (roles are CLUSTER-GLOBAL and every run rotates them)
//      or on a database vanishing mid-suite (`3D000`, from globalSetup's unconditional
//      `DROP DATABASE … WITH (FORCE)`). `28P01` is not in the transient allowlist, so contention was
//      being certified as a real bug — the most expensive possible misclassification, because this
//      is exactly the channel we trust.
//
// Usage (CI):  node scripts/nightly-rls-classify.mjs <logfile> --attempt N   [--github-output]
// Exit code is always 0 — the caller owns the run's exit status; this only describes it.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Bucket labels. The workflow prints these verbatim into the issue body, so they are the contract. */
export const TRANSIENT = "TRANSIENT";
export const NON_TRANSIENT = "NON-TRANSIENT";
export const CONTENTION = "CONTENTION";

/** Markers of a transient Neon/network failure worth one retry. A plain AssertionError matches none. */
const TRANSIENT_MARKERS =
  /CONNECT_TIMEOUT|Test timed out|Hook timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|Connection terminated|terminating connection|the database system is (starting up|shutting down)|too many clients|Client has encountered a connection error|fetch failed/i;

/**
 * Contention, NOT a bug in the code under test: something else was touching the same branch.
 *
 * Scoped deliberately tightly. A `28P01` is only contention when it names one of OUR cluster-global
 * roles (every run rotates those, so a concurrent run invalidates this one's credentials mid-flight),
 * and a missing database is only contention when it is one of the harness's own `webhook_test_*`
 * databases (globalSetup's sweep drops those with no age guard or lease). A 28P01 on some other role,
 * or a missing `webhook_prod`, is a real failure and must not be excused.
 */
const CONTENTION_MARKERS = [
  /password authentication failed for user ["']?webhook_[a-z_]*/i,
  /database ["']?webhook_test_[0-9a-f]+["']? does not exist/i,
];

/** vitest's "Failed Tests" banner and the summary line that follows the last failure. */
const FAILED_TESTS_BANNER = /^[⎯─-]*\s*Failed Tests\s+\d+\s*[⎯─-]*\s*$/m;
const SUMMARY_LINE = /^\s*Test Files\s+/m;

/**
 * Evidence that the run failed AT ALL, used to gate the whole-log fallback below.
 *
 * Without this gate the fallback re-creates the very defect this module exists to fix: a log with no
 * "Failed Tests" section still contains the tolerated `auth.sweep.skipped` noise, so a green — or
 * green-but-nonzero-exit — run would publish `permission denied for table auth_refresh_token` as its
 * "failure signature". Caught by the "a fully green log yields no signature at all" test.
 */
const FAILURE_EVIDENCE =
  /Unhandled Error|Unhandled Rejection|##\[error\]|^\s*Test Files\s+.*\bfailed\b|^\s*Tests\s+.*\bfailed\b|ELIFECYCLE/m;

/** The error shapes allowed into a public issue body. An ALLOWLIST, never raw log lines: a raw
 *  scrape can carry something unexpected (a connection string, a payload) out of the log. */
const SIGNATURE_SHAPES =
  /PostgresError: [^"\n]{0,70}|AssertionError: [^"\n]{0,70}|Error: [^"\n]{0,70}|permission denied for (?:table|function|relation|schema|sequence) [a-z_]+|password authentication failed for user .?[a-z_]+|database .?webhook_[a-z_0-9]+.? does not exist|Test timed out in [0-9]+ms|Hook timed out in [0-9]+ms|CONNECT_TIMEOUT|FAIL +[A-Za-z0-9/._-]+\.test\.ts/g;

const MAX_SIGNATURE_LINES = 8;

/**
 * Strip SGR colour codes so the banners and shapes below can match.
 *
 * TWO forms, both real and both present in this repo's logs:
 *   - \x1b[31m — what vitest writes into `test-db.out`, i.e. what CI actually classifies.
 *   - ^[[31m   — the LITERAL two characters `^` and `[`, which is how `gh run view --log` renders
 *     those same bytes. Anyone reproducing a failure from a downloaded log hits this second form.
 *
 * A stripper that omits the escape itself leaves it in place, so the "Failed Tests" banner never
 * matches, every scrape silently falls back to the UNSCOPED whole-log path, and the transient check
 * reads markers printed by passing tests. That was a live bug in the first cut of this file. The
 * \x1b form is pinned by the unit test below; the ^[ form was found only by running this against a
 * real downloaded run log, which is why scripts/fixtures/nightly-rls-717.log.txt is committed (the `.txt` suffix is load-bearing: .gitignore excludes *.log, so the fixture would silently not be committed and CI would fail on a test that passes locally).
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- matching terminal escapes is the entire point
  return String(text ?? "").replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, "");
}

/**
 * Narrow the log to vitest's "Failed Tests" section — the region between the banner and the
 * `Test Files` summary. Everything a PASSING test printed lives outside it.
 *
 * When there is no such section but the run clearly DID fail (the suite died before vitest reported —
 * a setup/infra fault), fall back to the whole log — but say so, because an unscoped scrape is
 * exactly the thing that misled #717's reader and must not be presented as if it were precise.
 *
 * When there is no such section AND no evidence of failure, return nothing: there is no signature to
 * report, and scraping anyway would just republish the tolerated noise.
 *
 * @param {string} log @returns {{text: string, scoped: boolean}}
 */
export function failureSection(log) {
  const clean = stripAnsi(log);
  const start = clean.search(FAILED_TESTS_BANNER);
  if (start === -1) {
    return { text: FAILURE_EVIDENCE.test(clean) ? clean : "", scoped: false };
  }
  const rest = clean.slice(start);
  const end = rest.search(SUMMARY_LINE);
  return { text: end === -1 ? rest : rest.slice(0, end), scoped: true };
}

/**
 * The bounded, deduplicated, allowlisted signature — built only from the failing region.
 * @param {string} log @returns {string[]}
 */
export function signatureLines(log) {
  const { text } = failureSection(log);
  const matches = text.match(SIGNATURE_SHAPES) ?? [];
  // A connection string can appear inside an otherwise-allowed `Error: …` prefix, so drop any match
  // that carries one rather than trusting the shape alone.
  const safe = matches.map((m) => m.trim()).filter((m) => !/[a-z]+:\/\//i.test(m));
  return [...new Set(safe)].sort().slice(0, MAX_SIGNATURE_LINES);
}

/** True when the FAILING region shows the marker — a match in passing output must not count. */
function failureRegionMatches(log, patterns) {
  const { text } = failureSection(log);
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((re) => re.test(text));
}

/**
 * Classify one attempt.
 *
 * `attempt` is re-inspected on its own evidence. The old shell hardcoded
 * "transient-looking, but failed BOTH attempts" on attempt 2 without re-reading the log, so a run
 * whose first attempt was transient and whose second failed deterministically was reported as
 * transient — the opposite of the truth.
 *
 * @param {{log: string|undefined, attempt: number}} input
 * @returns {{classification: string, signature: string, retry: boolean, bucket: string}}
 */
export function classify({ log, attempt = 1 }) {
  const text = stripAnsi(log ?? "");
  const last = attempt >= 2;
  const { scoped } = failureSection(text);

  let bucket;
  let classification;
  // CONTENTION is checked FIRST: a `28P01` matches no transient marker, so before this bucket
  // existed every contention failure fell through to NON-TRANSIENT and was certified a real bug.
  if (failureRegionMatches(text, CONTENTION_MARKERS)) {
    bucket = CONTENTION;
    classification =
      `${CONTENTION} — another consumer touched the branch while this run was in flight. ` +
      `Roles are cluster-global and every run rotates their passwords; globalSetup also drops ` +
      `\`webhook_test_*\` databases with no lease. This is NOT evidence of a bug in the code under ` +
      `test. Re-run when the branch is idle; if it recurs with nothing else running, investigate.`;
    // Scoped for the SAME reason the signature is. Run 29819273539's log contains `CONNECT_TIMEOUT`
    // in passing output AND in the workflow's own echoed grep pattern, so an unscoped test read that
    // deterministic #717 failure as TRANSIENT and asked to re-run the whole 4-hour suite for nothing.
  } else if (failureRegionMatches(text, TRANSIENT_MARKERS)) {
    bucket = TRANSIENT;
    classification = last
      ? `${TRANSIENT} — a transient-looking error on BOTH attempts. Neon latency is the likely ` +
        `cause, but two in a row is worth a look.`
      : `${TRANSIENT} — a timeout/connection error; retrying once.`;
  } else {
    bucket = NON_TRANSIENT;
    classification =
      `${NON_TRANSIENT} (a deterministic failure — not Neon latency)` +
      (last ? ", re-inspected on attempt 2 rather than inherited from attempt 1." : ".");
  }

  const lines = signatureLines(text);
  const signature = lines.length
    ? scoped
      ? lines.join("\n")
      : `${lines.join("\n")}\n(scraped from the whole log — the run produced no vitest "Failed Tests" ` +
        `section, so these lines are not known to come from a failing test.)`
    : "";

  // Only a transient FIRST attempt earns the retry. CONTENTION deliberately does not: the suite runs
  // for hours, and a second full pass risks colliding with the same consumer while doubling the cost.
  return { classification, signature, retry: bucket === TRANSIENT && !last, bucket };
}

/**
 * CLI.
 *   node scripts/nightly-rls-classify.mjs <log> --attempt N            → print the verdict
 *   …                                            --emit                → also write to GITHUB_OUTPUT
 *   …                                            --retryable           → EXIT 0 iff a retry is advised
 *
 * `--retryable` is an exit code rather than parsed stdout so the workflow can branch on it directly
 * (`if node …--retryable; then …`), with no shell text-matching in between to drift.
 *
 * `--emit` is opt-in so only the DECIDING attempt publishes its verdict: appending on every attempt
 * would leave attempt 1's classification in GITHUB_OUTPUT alongside attempt 2's.
 */
function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  const attemptFlag = argv.indexOf("--attempt");
  const attempt = attemptFlag === -1 ? 1 : Number(argv[attemptFlag + 1] || 1);
  let log;
  try {
    log = readFileSync(file, "utf8");
  } catch {
    // An unreadable log is itself reportable — classify() handles the empty case.
    log = "";
  }
  const { classification, signature, retry } = classify({ log, attempt });

  if (argv.includes("--retryable")) {
    process.exit(retry ? 0 : 1);
  }

  if (argv.includes("--emit") && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `classification=${classification}\nretry=${retry}\nsignature<<SIGEOF\n${signature}\nSIGEOF\n`,
    );
  }
  console.log(`classification: ${classification}`);
  console.log(`retry: ${retry}`);
  if (signature) console.log(`signature:\n${signature}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
