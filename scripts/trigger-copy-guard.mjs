#!/usr/bin/env node
/**
 * trigger-copy-guard — every user-facing surface that describes a webhook→agent trigger must describe
 * the transport it actually has: a caller-driven SHORT POLL over the durable event log, acked by cursor.
 *
 * WHY THIS EXISTS. `triggers.wait` is the product's flagship claim, and it is the single easiest thing in
 * this repo to describe wrongly, because the wrong description is the one everybody wants to be true.
 * ADR-0106 chose bounded-poll-over-the-log DELIBERATELY (MCP server-push is at-most-once and drops events
 * across a disconnect; see the ADR's "context"). Server-push is listed there as a possible future latency
 * hint, "never the guarantee itself." So "we push to your agent" is not a simplification of the design —
 * it is the design's rejected alternative, sold as the shipped one.
 *
 * The failure mode is specific and it has already happened twice. A developer reads "a pushed trigger, not
 * a poll" on the triggers page, registers a trigger, POSTs to their ingest URL, and nothing happens —
 * because nothing CAN happen until their client calls `triggers.wait`. They are now debugging a working
 * system against a false mental model we handed them. The deep pages (ADR-0106, /mcp/trigger-semantics,
 * the db + contract comments) have always been honest; the drift is concentrated in first-contact copy —
 * page ledes, frontmatter descriptions, nav card blurbs — which is exactly where the mental model forms.
 *
 * WHY A PHRASE LIST AND NOT A WORD LIST. The honest pages need the words. "short-poll pull, not push" and
 * "It does not push or wake the agent" are the CORRECT sentences; a guard banning /push/ would fail the
 * only files that get it right, and the natural way to appease it would be to delete the clarification.
 * So every entry below is a phrase that is false in ANY context it can appear in, negation included.
 *
 * WHY THE POSITIVE HALF. Banning the lie is not enough: a page can drop "pushed trigger, not a poll" and
 * leave "wake an agent when an event arrives", which is vague rather than false and rebuilds the same
 * wrong model. So the pages that INTRODUCE the primitive must also SAY the mechanism — poll / cadence /
 * cursor. A claim is allowed to be ambitious; it is not allowed to leave the mechanism unstated.
 *
 * FLOOR (anti-vacuity). A copy guard that scans nothing reads exactly like a clean one. So: an empty
 * surface list THROWS rather than reporting clean; a surface root that does not exist throws; each scanned
 * file is asserted non-empty; and every page on INTRODUCES must still be found by discovery, so a rename
 * fails loudly instead of quietly retiring its obligation. A missing path is a FAILURE, never a skip.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/**
 * Claims that are false about `triggers.wait` no matter how they are worded around.
 *
 * Each entry is { pattern, why } — `why` is printed on failure, because a guard that only says "forbidden
 * phrase" invites the author to reword until it passes rather than to find out what is true.
 *
 * Two optional same-line qualifiers keep the guard off honest sentences:
 *   - `exempt`   — the line is a NEGATION of the claim. "It does NOT block until an event arrives" is the
 *                  correct sentence; a guard that fails it teaches authors to delete the clarification,
 *                  which is the opposite of the point.
 *   - `needs`    — the claim is only false in a specific context. Capture really is instantaneous ("captured
 *                  the instant it arrives" is TRUE and load-bearing on three pages); it is the agent WAKING
 *                  that is bounded by the caller's cadence. So "instant" is flagged only next to a verb
 *                  about the agent acting, never next to capture.
 */
export const FORBIDDEN_CLAIMS = [
  {
    pattern: /\bpushed trigger\b/i,
    why: "there is no push. The agent's own call pulls the event (ADR-0106).",
  },
  {
    pattern: /\bnot a poll\b/i,
    why: "it IS a poll — a caller-driven short poll. That is the chosen design, not an embarrassment.",
  },
  {
    pattern: /\bnot polling\b/i,
    why: "it IS polling. Say short-poll and say who drives the cadence.",
  },
  {
    pattern: /\bpush(es|ed)?\s+(it\s+)?(to\s+)?(your|the)\s+agent\b/i,
    why: "nothing is pushed to the agent; the agent calls triggers.wait and receives what is past its cursor.",
  },
  {
    pattern: /\bstreams?\s+(it\s+)?to\s+(your|the)\s+agent\b/i,
    why: "there is no stream. Each call is one bounded scan that returns immediately.",
  },
  {
    // Same-sentence proximity, not adjacency: the live example that slipped a curated guard was
    // "have an MCP agent block on `triggers.wait` until a matching webhook lands" — four words of
    // separation was enough for /blocks? until/ to miss it entirely.
    // (Scanning is per-line, so proximity is already scoped; excluding "." would skip the very case
    // that motivated this, where the gap is a code span — `triggers.wait` — containing a dot.)
    pattern: /\bblocks?\b.{0,48}?\buntil\b/i,
    exempt: /\b(not|never|n't|no|rather than|instead of)\b/i,
    why: "triggers.wait never blocks — it returns immediately, empty if there is nothing past the cursor.",
  },
  {
    pattern: /\b(the\s+)?(instant|moment)\s+(one|it|an?\s+event|they|a\s+webhook)\b/i,
    // Capture IS instant. The agent waking is not — that is the caller's cadence.
    needs: /\b(wake|wakes|woken|waking|notified|acts?|acting|reacts?|responds?|triggered)\b/i,
    why: "the agent wakes on its own poll cadence, so it does not act 'the instant' an event lands (capture is instant; the wake is not).",
  },
  {
    pattern: /\breal-?time\b/i,
    why: "cadence is the caller's; 'real-time' promises a latency the transport does not offer.",
  },
];

/**
 * Words that state the actual mechanism. A page that introduces the primitive must contain at least one.
 * Deliberately broad — this half is a floor against vagueness, not a style rule.
 */
export const MECHANISM_WORDS = /\b(short-?poll|polls?|polling|cadence|cursor)\b/i;

/**
 * WHY SURFACES ARE DISCOVERED, NOT LISTED. The first cut of this guard carried a hand-written list of
 * thirteen files. It went green while `apps/docs/quickstart.mdx` said "have an MCP agent BLOCK on
 * triggers.wait until a matching webhook lands" — two false claims on one line, in a file nobody had
 * thought to add. That is the same failure the guard exists to prevent, one level up: a checker whose
 * input is a curated list reports on the list, not on the product, and reads exactly like a clean run.
 *
 * So the scope is derived from CONTENT: any user-facing file that talks about triggers is in, forever,
 * including files that do not exist yet. The claims below are only false ABOUT `triggers.wait`, so
 * scoping by mention (rather than scanning every file) keeps the guard from flagging, say, the CLI's
 * `listen` command, which legitimately blocks.
 */
const SURFACE_ROOTS = [
  { dir: "apps/docs", ext: [".mdx"] },
  { dir: "apps/www/src", ext: [".tsx", ".ts"] },
  { dir: "apps/web/src", ext: [".tsx", ".ts"] },
  { dir: "apps/mcp/src", ext: [".ts"] },
  { dir: "packages/cli/src", ext: [".ts"] },
];

/** Files that mention any of these are describing the trigger primitive. */
const TRIGGER_MENTION = /triggers?\.(wait|create)|agent trigger|webhook.?(→|->|to.)agent/i;

/**
 * Tests legitimately quote the lies in order to forbid them, and the guard's own fixtures ARE lies.
 * Excluding them keeps the guard from failing the code that enforces it.
 */
const EXCLUDED = /\.(test|spec)\.[tj]sx?$|scripts\/fixtures\/|trigger-copy-guard/;

/**
 * Pages where a reader FIRST meets the primitive, so they carry the positive obligation too: say the
 * mechanism, not just the outcome. Curated on purpose — "is this someone's first contact?" is an
 * editorial judgement no heuristic makes well. Each path is asserted to exist, so a rename fails loudly
 * instead of quietly retiring the obligation.
 */
export const INTRODUCES = [
  "apps/web/src/app/(app)/org/[slug]/triggers/page.tsx",
  "apps/web/src/components/agent-triggers-manager.tsx",
  "apps/www/src/app/product/agent-triggers/page.tsx",
  "apps/docs/mcp/wake-an-agent.mdx",
  "apps/docs/mcp/trigger-semantics.mdx",
  "apps/docs/recipes/wake-an-agent.mdx",
];

/** Walk the roots and return every user-facing file that mentions the trigger primitive. */
export function discoverSurfaces() {
  /** @type {{path: string, introduces: boolean}[]} */
  const found = [];
  for (const { dir, ext } of SURFACE_ROOTS) {
    const abs = repoFile(dir);
    if (!existsSync(abs)) throw new Error(`trigger-copy-guard: surface root ${dir} does not exist`);
    for (const entry of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!ext.some((e) => entry.name.endsWith(e))) continue;
      const rel = `${dir}/${entry.parentPath.slice(abs.length).replace(/^\//, "")}/${entry.name}`
        .replace(/\/+/g, "/")
        .replace(/\/$/, "");
      if (EXCLUDED.test(rel)) continue;
      if (!TRIGGER_MENTION.test(readFileSync(repoFile(rel), "utf8"))) continue;
      found.push({ path: rel, introduces: INTRODUCES.includes(rel) });
    }
  }
  found.push({ path: "README.md", introduces: false });

  // A rename must fail loudly, not silently retire the positive obligation.
  for (const path of INTRODUCES) {
    if (!found.some((f) => f.path === path)) {
      found.push({ path, introduces: true }); // scanSurfaces reports it as missing
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** @returns {{file: string, line: number, text: string, why: string}[]} */
export function scanSurfaces(surfaces = discoverSurfaces()) {
  if (surfaces.length === 0)
    throw new Error("trigger-copy-guard: empty surface list — nothing scanned");
  /** @type {{file: string, line: number, text: string, why: string}[]} */
  const violations = [];

  for (const { path, introduces } of surfaces) {
    const abs = repoFile(path);
    if (!existsSync(abs)) {
      violations.push({
        file: path,
        line: 0,
        text: "(missing)",
        why: "surface listed in the guard does not exist — it moved or was renamed. Update SURFACES; do not drop it.",
      });
      continue;
    }
    const source = readFileSync(abs, "utf8");
    if (source.trim().length === 0) {
      violations.push({ file: path, line: 0, text: "(empty)", why: "surface file is empty" });
      continue;
    }

    const lines = source.split("\n");
    lines.forEach((text, i) => {
      for (const { pattern, why, exempt, needs } of FORBIDDEN_CLAIMS) {
        if (!pattern.test(text)) continue;
        if (exempt?.test(text)) continue;
        if (needs && !needs.test(text)) continue;
        violations.push({ file: path, line: i + 1, text: text.trim(), why });
      }
    });

    if (introduces && !MECHANISM_WORDS.test(source)) {
      violations.push({
        file: path,
        line: 0,
        text: "(whole file)",
        why: "introduces triggers but never states the mechanism — say short-poll / cadence / cursor.",
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const violations = scanSurfaces();
  const scanned = discoverSurfaces().length;
  if (violations.length > 0) {
    console.error("trigger-copy-guard: trigger copy claims what the transport does not do.\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.text}`);
      console.error(`    ↳ ${v.why}\n`);
    }
    console.error(
      `${violations.length} violation(s). The transport is ADR-0106: a caller-driven short poll.`,
    );
    process.exit(1);
  }
  console.log(`trigger-copy-guard: ${scanned} surfaces clean.`);
}
