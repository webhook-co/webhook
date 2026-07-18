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
// ── How it reads source, and why it does NOT read it line by line ────────────────────────────────
//
// The first version of this guard matched claims per-line and judged denial over a 3-line window.
// Both halves were wrong, and a code review caught it before it shipped:
//
//   * A claim that WRAPPED was invisible. Prettier splits `<Stat n="3.4M" k="events / day" />` across
//     four lines the moment it's nested one level deeper — and then no single line holds both the
//     magnitude and the unit, so the guard sailed past the exact stat it was written to catch.
//   * A denial ANYWHERE in the preceding two lines silenced the rule — including a denial inside a
//     code COMMENT. "Your data is never shared. We are SOC 2 Type II certified." passed clean,
//     because "never" was in the neighbourhood.
//
// So: strip comments, collapse all whitespace to single spaces, and evaluate rules against that.
// Claims can then never hide in a line break, comments can never launder them, and denial is judged
// within the SAME CLAUSE as the claim — not merely nearby.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { IGNORED_DIRS, isMain, walkDocs } from "./lib/docs-lib.mjs";

const ROOT = process.cwd();

// User-facing UI. Legal pages live under apps/www/src/app/<policy>/ and are the source of truth for
// what we DON'T have — they're kept honest by the affirmative-only patterns, not by a path exclusion.
// apps/web is in scope because the BAA claim was repeated INSIDE the authenticated product.
const SCANNED = ["apps/www/src", "apps/auth/src", "apps/web/src", "packages/ui/src"];

// The knowledge base (apps/docs) is a user-facing surface too — the same SLA/cert/SSO/BAA boasts can
// land in a doc as easily as in a marketing page, and until now nothing scanned it. Docs are stripped
// by scanMdx (code fences + MDX/HTML comments), not by the JS stripper. Both .mdx and .md count —
// the sibling docs-nav-guard treats .md as a page, so the honesty scan must not skip it (walkDocs
// covers both, and scans snippets too: a boast in a reused fragment still ships).
const SCANNED_MDX = ["apps/docs"];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Each rule matches the SHAPE of an unbacked boast. The `why` is printed on failure so the next
 * person doesn't have to reverse-engineer the rule from a regex.
 *
 *  - `deniable`  the legal pages must be able to say we do NOT have this thing, in the same words a
 *                boast would use. Only certs and BAAs qualify: "we hold no SOC 2 certification" is a
 *                sentence we MUST be able to publish. "no 38ms median latency" is not a sentence
 *                anyone writes, so the metric rules are absolute.
 *  - `unless`    a context that makes the number legitimate. A plan QUOTA ("your plan includes 5M
 *                events / month") is a contract term we can prove — the opposite of a boast about how
 *                much traffic we handle. Without this, the guard bans the one volume number that is
 *                actually true.
 */
export const CLAIM_RULES = [
  {
    id: "uptime-sla",
    // "99.9% uptime", "99.99% delivery SLA" — a percentage bound to an availability word.
    re: /\d{2}(\.\d+)?\s*%[^.\n]{0,24}\b(sla|uptime|availability)/i,
    why: "we publish no SLA — the Terms say 'no guaranteed uptime or service-level commitment'",
  },
  {
    id: "latency-metric",
    // "38ms median latency", "sub-50ms p99" — a duration bound to a performance word.
    re: /\d+\s*ms\b[^.]{0,24}\b(latency|p50|p95|p99|median|average|avg)\b/i,
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
    // Exempt when it's a plan quota: that number is the billed contract, not a boast about our scale.
    re: /\d+(\.\d+)?\s*[KMB]\+?\b[^.]{0,24}\b(events|requests|webhooks|deliveries)\b/i,
    unless:
      /\b(includes?|included|plan|quota|allowance|cap|capped|limit|up to|per (month|seat))\b/i,
    why: "we do not publish traffic volume (a PLAN QUOTA is fine — say 'includes'/'up to')",
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
    // "SOC 2 compliant/certified", "HIPAA compliant" — a cert bound to a claim verb.
    re: /\b(soc\s?2|iso\s?27001|hipaa|pci[- ]dss)\b[^.]{0,24}\b(compliant|certified|certification|attested|audited)\b/i,
    why: "we hold none of these certifications — the DPA and AUP say so explicitly",
  },
  {
    id: "baa-offer",
    deniable: true,
    // Any mention of a BAA that isn't a denial. Deliberately just the noun (singular OR plural): the
    // first version required a verb in front of it, so "we sign BAAs" — the AUP's own wording, in the
    // plural — slipped straight through the gate. The only honest sentences containing "BAA" are the
    // ones refusing to sign one, and `deniable` already lets those through.
    re: /\bbaas?\b/i,
    why: "the Terms say we 'provide no BAA' and the AUP says 'we do not sign BAAs'",
  },
  {
    id: "guarantee",
    re: /\b(guaranteed delivery|never lose (an? )?event|100% (uptime|delivery|reliable))\b/i,
    why: "delivery is best-effort with a dead-letter queue — we guarantee nothing",
  },
  {
    id: "sso-offer",
    // The €499 Enterprise tier sold "SAML SSO" alongside the BAA. Deleting the words is not the same
    // as pinning them: without a rule, the exact string can be pasted back tomorrow and every test
    // stays green. The only honest SSO surface we have is a DISABLED "coming soon" button — so that
    // is precisely what `unless` permits, and nothing else.
    re: /\b(saml|sso|single sign-on)\b/i,
    unless: /\b(coming soon|disabled|waitlist|not yet|soon)\b/i,
    why: "SSO is a disabled 'coming soon' button — we do not offer it. Say 'coming soon', or nothing",
  },
  {
    id: "audit-export-offer",
    // Same tier, same defect, one line down. `audit.verify` (hash-chain verification) exists; an
    // EXPORT does not.
    re: /\baudit\s+(log\s+)?export\b|\bexport\s+(the\s+|your\s+)?audit\b/i,
    why: "there is no audit export — `audit.verify` verifies the hash chain; it does not export",
  },
];

/**
 * A clause that DENIES having something is the honesty we're protecting, not a violation of it.
 *
 * "We hold **no** SOC 2, ISO 27001, HIPAA, or PCI certification" is the DPA telling the truth — and a
 * naive cert-rule flags it, because "certification" sits right after the cert name. A guard that
 * silenced the legal pages would be worse than the bug it was written for: it would launder the
 * honesty out of the product and leave only the boasts.
 *
 * But the denial must be in the SAME CLAUSE as the claim. Judged over a loose neighbourhood, any
 * incidental "no"/"not"/"never" — in prose, or in a nearby code comment — becomes a skeleton key that
 * unlocks a boast. That is the difference between "we are NOT SOC 2 certified" and "your data is
 * never shared. We are SOC 2 certified."
 */
const DENIAL = /\b(no|not|never|non|without|don't|doesn't|cannot|can't|lack|lacks|refuse)\b/i;

/**
 * A clause boundary in normalized source. `. ` (period + space) is safe: it does not split "3.4M" or
 * "99.99%", whose periods are followed by a digit. `;`, `!` and `?` end a thought too.
 *
 * Deliberately NOT `>`: "We're <strong>not</strong> SOC 2 certified" would then have its denial
 * amputated by the closing tag, and the privacy policy would be flagged for being honest.
 */
const CLAUSE_END = /[.;!?]\s|[;!?]/g;

/** Blank out `//`, `/* *\/` and `{/* *\/}` comments, preserving byte offsets so lines still map. */
export function stripComments(src) {
  const out = src.split("");
  let i = 0;
  let mode = null; // "line" | "block" | "sq" | "dq" | "tpl"
  const blank = (n) => {
    if (out[n] !== "\n") out[n] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === null) {
      if (two === "//") {
        mode = "line";
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (two === "/*") {
        mode = "block";
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (src[i] === "'") mode = "sq";
      else if (src[i] === '"') mode = "dq";
      else if (src[i] === "`") mode = "tpl";
      i++;
      continue;
    }
    if (mode === "line") {
      if (src[i] === "\n") mode = null;
      else blank(i);
      i++;
      continue;
    }
    if (mode === "block") {
      if (two === "*/") {
        blank(i);
        blank(i + 1);
        mode = null;
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    // Inside a string literal: don't treat // or /* as a comment, and honour escapes.
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && src[i] === "'") ||
      (mode === "dq" && src[i] === '"') ||
      (mode === "tpl" && src[i] === "`")
    ) {
      mode = null;
    }
    i++;
  }
  return out.join("");
}

/**
 * Collapse runs of whitespace to a single space, keeping a map from each output index back to the
 * source offset it came from. This is what lets a claim be found even when prettier has wrapped it
 * across four lines — and what lets us still report the line it landed on.
 */
export function normalize(src) {
  let text = "";
  const map = [];
  let prevWs = false;
  for (let i = 0; i < src.length; i++) {
    const ws = /\s/.test(src[i]);
    if (ws) {
      if (!prevWs) {
        text += " ";
        map.push(i);
      }
      prevWs = true;
    } else {
      text += src[i];
      map.push(i);
      prevWs = false;
    }
  }
  return { text, map };
}

/**
 * Blank out MDX code and comments while PRESERVING byte offsets (spaces for content, newlines kept),
 * so line reporting still maps. MDX — not JavaScript — is what the knowledge base is written in, so
 * this is deliberately NOT `stripComments`: prose is full of apostrophes and quotes ("we're",
 * "don't", a quoted phrase) that a JS string-literal scanner would mis-read, and code fences hold
 * example payloads whose numbers must never be mistaken for a boast.
 *
 * Removed, in order: fenced code blocks (``` or ~~~, 3+, through their closing fence), then MDX
 * expression comments `{/* *\/}`, HTML comments `<!-- -->`, and inline code spans. Fences go first so
 * a stray backtick or brace inside a code sample can't be re-interpreted afterwards. An UNCLOSED
 * fence blanks to end-of-file — the conservative choice: it can only hide a claim (a false negative
 * a reviewer still sees in the diff), never invent one.
 */
export function stripMdx(src) {
  const out = src.split("");
  const blank = (start, end) => {
    for (let i = start; i < end && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };

  // 1) Fenced code blocks — only CLOSED pairs are blanked. An UNCLOSED fence (a mistyped or omitted
  // closing ```) is left intact and scanned. This is the safe direction for an honesty guard: the
  // earlier "blank to end-of-file" behaviour meant one malformed fence silently stripped — and thus
  // hid from the scanner — every claim below it ("99.9% uptime SLA", "SOC 2 certified"), the exact
  // boast SCANNED_MDX exists to catch. Erring toward over-scanning risks a false positive (CI fails,
  // the author fences the block); erring toward blank-to-EOF risks a false negative (the claim ships).
  const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
  let lineStart = 0;
  let openAt = -1; // byte offset where the open fence line starts, or -1 when not in a fence
  let fence = null; // { char, len }
  while (lineStart <= src.length) {
    let lineEnd = src.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = src.length;
    const line = src.slice(lineStart, lineEnd);
    if (!fence) {
      const m = FENCE_OPEN.exec(line);
      if (m) {
        fence = { char: m[2][0], len: m[2].length };
        openAt = lineStart;
      }
    } else {
      const closeRe = new RegExp(`^\\s*${fence.char}{${fence.len},}\\s*$`);
      if (closeRe.test(line)) {
        blank(openAt, lineEnd); // blank the whole block, open and close fences included
        fence = null;
        openAt = -1;
      }
    }
    if (lineEnd === src.length) break;
    lineStart = lineEnd + 1;
  }
  // Unclosed fence at EOF: deliberately NOT blanked — leave it scannable.

  // 2..4) Comments and inline code, matched over the fence-blanked text so nothing inside a fence
  // can match. Double-backtick spans before single so `` `x` `` isn't split.
  const stripPattern = (re) => {
    const text = out.join("");
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      blank(m.index, m.index + m[0].length);
    }
  };
  stripPattern(/\{\/\*[\s\S]*?\*\/\}/g); // {/* MDX expression comment */}
  stripPattern(/<!--[\s\S]*?-->/g); // <!-- HTML comment -->
  stripPattern(/``[^`\n]+``/g); // ``inline code``
  stripPattern(/`[^`\n]+`/g); // `inline code`

  return out.join("");
}

/**
 * The pure core: given source ALREADY stripped of its comments/code, find every claim. Runs over a
 * WHOLE FILE — the same way production runs it. (The previous test suite exercised a per-line helper
 * with a defaulted context argument, which is to say: it tested a code path the scanner never took.
 * Every denial test passed against a window production doesn't use.) `scanSource` and `scanMdx` share
 * this so the rules and clause-scoped denial are identical across TSX and MDX.
 */
export function scanStripped(stripped, src, file) {
  const { text, map } = normalize(stripped);
  const lineAt = (srcOffset) => {
    let n = 1;
    for (let i = 0; i < srcOffset && i < src.length; i++) if (src[i] === "\n") n++;
    return n;
  };

  const hits = [];
  // One report per (line, rule). "SAML SSO" trips `sso-offer` twice — once per word — and a failure
  // list that says the same thing twice reads like two problems.
  const seen = new Set();
  for (const rule of CLAIM_RULES) {
    const re = new RegExp(
      rule.re.source,
      rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g",
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") break;

      // The clause the claim sits in: back up to the previous clause boundary.
      CLAUSE_END.lastIndex = 0;
      let clauseStart = 0;
      let b;
      while ((b = CLAUSE_END.exec(text)) !== null && b.index < m.index) {
        clauseStart = b.index + b[0].length;
      }
      const clause = text.slice(clauseStart, m.index + m[0].length);

      if (rule.deniable && DENIAL.test(clause)) continue;
      if (rule.unless && rule.unless.test(clause)) continue;

      const line = lineAt(map[m.index] ?? 0);
      const key = `${line}:${rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({ file, line, id: rule.id, why: rule.why, text: clause.trim().slice(0, 120) });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Scan a JS/TS/TSX source file: strip JS comments, then run the shared core. */
export function scanSource(src, file = "x.tsx") {
  return scanStripped(stripComments(src), src, file);
}

/** Scan an MDX doc (apps/docs): strip MDX code + comments, then run the SAME rules as scanSource. */
export function scanMdx(src, file = "x.mdx") {
  return scanStripped(stripMdx(src), src, file);
}

async function* walk(dir, match = SOURCE_FILE) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name), match);
    } else if (match.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

if (isMain(import.meta.url)) {
  const violations = [];
  let total = 0;

  for (const tree of SCANNED) {
    let seen = 0;
    // A guard on the guard, PER TREE. The old version tolerated a missing directory and only failed
    // if ALL FOUR vanished — so a renamed app would silently drop out of the sweep while the check
    // still printed a tick. A gate that reports success over a tree it never opened is worse than no
    // gate: it looks exactly like coverage.
    try {
      for await (const file of walk(join(ROOT, tree))) {
        seen++;
        violations.push(...scanSource(await readFile(file, "utf8"), relative(ROOT, file)));
      }
    } catch (err) {
      console.error(`✗ cannot scan ${tree}: ${err.message}`);
      process.exit(1);
    }
    if (seen === 0) {
      console.error(`✗ scanned 0 files in ${tree} — the tree moved. Refusing to pass vacuously.`);
      process.exit(1);
    }
    total += seen;
  }

  // Same sweep, same per-tree floor, over the docs (.mdx + .md) — using scanMdx instead of scanSource.
  for (const tree of SCANNED_MDX) {
    let seen = 0;
    try {
      for await (const file of walkDocs(join(ROOT, tree))) {
        seen++;
        violations.push(...scanMdx(await readFile(file, "utf8"), relative(ROOT, file)));
      }
    } catch (err) {
      console.error(`✗ cannot scan ${tree}: ${err.message}`);
      process.exit(1);
    }
    if (seen === 0) {
      console.error(
        `✗ scanned 0 doc files in ${tree} — the tree moved. Refusing to pass vacuously.`,
      );
      process.exit(1);
    }
    total += seen;
  }

  if (violations.length > 0) {
    console.error("✖ Found claims we cannot stand behind:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.id}]\n      ${v.why}\n      → ${v.text}`);
    }
    console.error(
      "\nWe're early. A number nobody measured is the one claim a reader cannot check — and the first\n" +
        "thing that makes them doubt everything else. Remove it, or wire it to something real.",
    );
    process.exit(1);
  }

  console.log(`✔ No unverified claims — scanned ${total} files.`);
}
