#!/usr/bin/env node
// Fails if any user-facing surface publishes a metric or certification we cannot stand behind.
// Wired into `pnpm lint`.
//
// This exists because we shipped all of these at once:
//   - "99.99% delivery SLA" on the sign-in page — while our own Terms say the service runs on a
//     "best-effort basis with no guaranteed uptime or service-level commitment". The login screen
//     sold an SLA the contract a user accepts ON THAT SAME SCREEN explicitly disclaims.
//   - "38ms median latency" and "3.4M events / day" — numbers nobody measured.
//   - "All systems operational" with a green dot, on every page, wired to nothing.
//   - "SAML SSO … and a BAA" on the €499 Enterprise tier — while the AUP says "we do not sign BAAs"
//     and SSO is a DISABLED "coming soon" button.
//
// A number nobody measured is worse than no number: it is the one claim a reader cannot check, and
// the first thing that makes them doubt everything else. We're early. Say less, and mean it.
//
// SCOPE: this bans AFFIRMATIVE claims, not the words. The legal pages must keep saying
// "we hold no SOC 2, ISO 27001, HIPAA, or PCI certification" and "no guaranteed uptime" — that's the
// honesty we're protecting. So the patterns below match the SHAPE of a boast (a number bound to a
// unit, a cert bound to a claim verb), never the bare noun.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

// User-facing UI only. Legal pages live under apps/www/src/app/<policy>/ and are the source of truth
// for what we DON'T have — they're excluded by the affirmative-only patterns, not by path.
const SCANNED = ["apps/www/src", "apps/auth/src", "apps/web/src", "packages/ui/src"];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "out"]);

/**
 * Each rule matches the SHAPE of an unbacked boast. The `why` is printed on failure so the next
 * person doesn't have to reverse-engineer the rule from a regex.
 */
export const CLAIM_RULES = [
  {
    id: "uptime-sla",
    // "99.9% uptime", "99.99% delivery SLA" — a percentage bound to an availability word.
    re: /\d{2}(\.\d+)?\s*%[^.\n]{0,24}\b(sla|uptime|availability|availab)/i,
    why: "we publish no SLA — the Terms say 'no guaranteed uptime or service-level commitment'",
  },
  {
    id: "latency-metric",
    // "38ms median latency", "sub-50ms p99" — a duration bound to a performance word.
    re: /\d+\s*ms\b[^.\n]{0,24}\b(latency|p50|p95|p99|median|average|avg)\b/i,
    why: "we do not measure or publish latency",
  },
  {
    id: "latency-metric-reversed",
    re: /\b(median|average|avg|p50|p95|p99)\s+latency\b/i,
    why: "we do not measure or publish latency",
  },
  {
    id: "volume-metric",
    // "3.4M events / day", "1.2B requests per month" — a magnitude bound to a throughput unit.
    //
    // The gap-tolerance is load-bearing, not sloppiness. The stat we actually shipped was
    // `<Stat n="3.4M" k="events / day" />` — the magnitude and the unit lived in SEPARATE JSX
    // ATTRIBUTES, so a pattern requiring them to be adjacent (`3.4M events`) sailed straight past the
    // real thing while happily catching the prose version of it. A guard tested only against prose is
    // a guard tested against a claim nobody shipped.
    re: /\d+(\.\d+)?\s*[KMB]\+?\b[^.\n]{0,24}\b(events|requests|webhooks|deliveries)\b/i,
    why: "we do not publish traffic volume",
  },
  {
    id: "social-proof-count",
    // "trusted by 400 teams", "used by 10,000 developers" — a count of customers we don't have.
    re: /\b(trusted|used|loved|chosen)\s+by\s+[\d,]+/i,
    why: "we do not have (or publish) a customer count",
  },
  {
    id: "customer-count",
    re: /\b[\d,]{2,}\+?\s+(customers|companies|teams|developers|engineers)\b/i,
    why: "we do not have (or publish) a customer count",
  },
  {
    id: "status-indicator",
    // A hardcoded health indicator with no health check behind it.
    re: /\ball systems (operational|go|nominal)\b/i,
    why: "there is no status page and nothing monitoring anything — wire one before claiming one",
  },
  {
    id: "certification-claim",
    deniable: true,
    // "SOC 2 compliant/certified", "HIPAA compliant" — a cert bound to a CLAIM verb. The legal pages
    // say "we hold NO SOC 2…", which has no claim verb after the cert and so does not match.
    re: /\b(soc\s?2|iso\s?27001|hipaa|pci[- ]dss)\b[^.\n]{0,20}\b(compliant|certified|certification|attested|audited)\b/i,
    why: "we hold none of these certifications — the DPA and AUP say so explicitly",
  },
  {
    id: "baa-offer",
    deniable: true,
    // Offering a BAA. Terms: "provide no BAA". AUP: "we do not sign BAAs".
    re: /\b(a|the|sign|offer|provide|and)\s+baa\b/i,
    why: "the Terms say we 'provide no BAA' and the AUP says 'we do not sign BAAs'",
  },
  {
    id: "guarantee",
    re: /\b(guaranteed delivery|never lose (an? )?event|100% (uptime|delivery|reliable))\b/i,
    why: "delivery is best-effort with a dead-letter queue — we guarantee nothing",
  },
];

/**
 * A line that DENIES having something is the honesty we're protecting, not a violation of it.
 *
 * "We hold **no** SOC 2, ISO 27001, HIPAA, or PCI certification" is the DPA telling the truth — and a
 * naive cert-rule flags it, because "certification" sits right after the cert name. A guard that
 * silenced the legal pages would be worse than the bug it was written for: it would launder the
 * honesty out of the product and leave only the boasts.
 */
const DENIAL = /\b(no|not|never|non|without|don't|doesn't|cannot|can't|lack|hold no|refuse)\b/i;

/**
 * Pure core: every unbacked claim on one line.
 *
 * `context` is the line plus the couple before it, because PROSE WRAPS AND DENIAL DOESN'T FOLLOW IT.
 * The privacy policy reads "We're **not** SOC 2 / HIPAA certified" — with "not" on one line and the
 * claim on the next. Judged line-by-line, the guard would flag the privacy policy for telling the
 * truth. Judged over the window, it doesn't.
 */
export function findClaims(line, file, lineNo, context = line) {
  const denied = DENIAL.test(context);
  const hits = [];
  for (const rule of CLAIM_RULES) {
    if (!rule.re.test(line)) continue;
    // Only certs and BAAs are deniable — they're the two things the legal pages must say out loud we
    // do NOT have, in the same words a boast would use. Every other rule needs a hard number or an
    // exact phrase the legal pages never use, so a nearby "no" is a coincidence, not a disclaimer —
    // and `guarantee` has a negation INSIDE its own pattern ("never lose an event"), so making it
    // deniable would have taught the guard to skip the exact boast it exists to catch.
    if (rule.deniable && denied) continue;
    hits.push({ file, line: lineNo, id: rule.id, why: rule.why });
  }
  return hits;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const violations = [];
  let scanned = 0;

  for (const tree of SCANNED) {
    for await (const file of walk(join(ROOT, tree))) {
      scanned++;
      const contents = await readFile(file, "utf8");
      const lines = contents.split(/\r?\n/);
      let inJsxComment = false;
      lines.forEach((line, idx) => {
        // A line that's only a comment is documentation ABOUT the rule (like this file's own header),
        // not a published claim. Skip it, or the guard flags its own explanation.
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
        if (inJsxComment) {
          if (line.includes("*/")) inJsxComment = false;
          return;
        }
        if (/\{\/\*/.test(line) && !line.includes("*/")) inJsxComment = true;
        // Denial is judged over the line plus the two before it. JSX prose wraps mid-sentence, so
        // "We're **not** / SOC 2 / HIPAA certified" lands the negation on a different line from the
        // claim — and a line-local check would flag the privacy policy for being honest.
        const context = lines.slice(Math.max(0, idx - 2), idx + 1).join(" ");
        violations.push(...findClaims(line, relative(ROOT, file), idx + 1, context));
      });
    }
  }

  // A guard on the guard: if the scanned trees ever move, this must fail loudly rather than pass on
  // an empty sweep. A check that reports success when it checked nothing looks exactly like coverage.
  if (scanned === 0) {
    console.error("✗ scanned 0 files — the source trees moved. Refusing to pass vacuously.");
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error("✖ Found claims we cannot stand behind:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.id}]\n      ${v.why}`);
    }
    console.error(
      "\nWe're early. A number nobody measured is the one claim a reader cannot check — and the first\n" +
        "thing that makes them doubt everything else. Remove it, or wire it to something real.",
    );
    process.exit(1);
  }

  console.log(`✔ No unverified claims — scanned ${scanned} files.`);
}
