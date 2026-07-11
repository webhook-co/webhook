import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { findAbsoluteTypeSizes } from "./no-absolute-type-size.mjs";

const find = (line) => findAbsoluteTypeSizes(line, "x.tsx", 1);
const SCRIPT = fileURLToPath(new URL("./no-absolute-type-size.mjs", import.meta.url));

/** Run the guard as a real subprocess against a throwaway tree. Returns {status, output}. */
function runGuard(files) {
  const root = mkdtempSync(join(tmpdir(), "type-size-guard-"));
  try {
    mkdirSync(join(root, "apps", "x", "src"), { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(root, "apps", "x", "src", name), contents);
    }
    try {
      const output = execFileSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (err) {
      return { status: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("flags a fixed-px arbitrary type size", () => {
  assert.equal(find('<p className="text-[13px]">').length, 1);
  assert.equal(find('<span className="font-mono text-[10px] uppercase">').length, 1);
});

test("flags fractional px too — 11.5px is just as decoupled from the scale", () => {
  assert.equal(find('<p className="text-[11.5px]">').length, 1);
  assert.equal(find('<code className="text-[12.5px]">').length, 1);
});

// Fluid display type is a deliberate, documented opt-out of the step scale: a marketing headline
// interpolates between two sizes across the viewport, which no discrete token can express. It still
// scales with zoom, so it is not the regression this guard exists to prevent.
test("allows fluid clamp() display type", () => {
  assert.equal(find('<h1 className="text-[clamp(38px,5.2vw,62px)]">').length, 0);
  assert.equal(find('<h2 className="text-[clamp(26px,4vw,38px)] leading-[1.12]">').length, 0);
});

test("allows root-relative arbitrary type", () => {
  assert.equal(find('<span className="text-[0.6875rem]">').length, 0);
  assert.equal(find('<span className="text-[1.125em]">').length, 0);
});

// The scale steps themselves are the whole point — never flag them.
test("allows the named scale steps", () => {
  assert.equal(find('<p className="text-sm text-fg-muted">').length, 0);
  assert.equal(find('<p className="text-base">').length, 0);
  assert.equal(find('<p className="text-md leading-body">').length, 0);
});

// Only *type* is guarded. A 3px focus rail or a 1px hairline is a physical detail that should stay
// put; forcing those to rem would be cargo-culting the rule past its purpose.
test("ignores non-type arbitrary px (heights, widths, rails)", () => {
  assert.equal(find('<div className="h-[42px] w-[240px] before:w-[3px]">').length, 0);
  assert.equal(find('<div className="max-w-[280px] leading-[1.05]">').length, 0);
});

test("does not mistake a longer utility that merely ends in -text for the type scale", () => {
  assert.equal(find('<div className="scroll-mt-[13px]">').length, 0);
});

test("reports file and line so the failure is actionable", () => {
  const [hit] = findAbsoluteTypeSizes('  <p className="text-[13px]">', "apps/www/src/a.tsx", 42);
  assert.equal(hit.file, "apps/www/src/a.tsx");
  assert.equal(hit.line, 42);
  assert.equal(hit.match, "text-[13px]");
});

test("catches several on one line", () => {
  assert.equal(find('<p className="text-[10px] md:text-[13px]">').length, 2);
});

// A responsive/state variant is still a fixed px size — the prefix must not smuggle it past.
test("sees through responsive and state variants", () => {
  assert.equal(find('<p className="sm:text-[13px]">').length, 1);
  assert.equal(find('<p className="hover:text-[13px]">').length, 1);
  assert.equal(find('<p className="dark:md:text-[11px]">').length, 1);
});

// THE BLIND SPOT THAT MATTERED. The first version of this guard modelled the variant prefix as
// `(?:[a-z-]+:)*`, which admits only plain word variants — so it scored ZERO hits on the `[&_x]:`
// descendant idiom. That idiom is exactly how `legal-doc.tsx` authors the legal column, and a
// `[&_blockquote]:text-sm` (13px) rule in precisely that form is the bug this whole guard exists to
// prevent. It would have printed "✔ No absolute-px font sizes found" over its own use case.
test("sees through the [&_x]: descendant-variant idiom this codebase actually authors prose in", () => {
  assert.equal(find('"[&_blockquote]:text-[13px] [&_p]:mt-6"').length, 1);
  assert.equal(find('"[&_h2]:text-xl [&_table]:text-[12px]"').length, 1);
});

test("sees through named-group and arbitrary-breakpoint variants", () => {
  assert.equal(find('"group-hover/anchor:text-[13px]"').length, 1);
  assert.equal(find('"max-[600px]:text-[13px]"').length, 1);
  assert.equal(find('"data-[state=open]:text-[11px]"').length, 1);
});

// The arbitrary-breakpoint variant carries its own `px` — make sure that isn't what we matched.
test("does not mistake a variant's own px value for a font size", () => {
  assert.equal(find('<div className="max-[600px]:flex">').length, 0);
  assert.equal(find('<div className="max-[600px]:text-sm">').length, 0);
});

// ── the CLI path ────────────────────────────────────────────────────────────────
// Testing only the pure core would leave the entry guard untested — and a broken entry guard makes
// the whole gate a no-op that still exits 0 and prints nothing. That failure mode is invisible
// precisely because it looks like success, so the script has to actually be RUN.

test("CLI: exits non-zero and names the offender when a fixed-px size is present", () => {
  const { status, output } = runGuard({
    "bad.tsx": '<p className="text-[13px]">nope</p>\n',
  });
  assert.equal(status, 1, "the guard must FAIL the build, not just print");
  assert.match(output, /text-\[13px\]/);
  assert.match(output, /bad\.tsx/);
});

test("CLI: exits zero and says so when the tree is clean", () => {
  const { status, output } = runGuard({
    "good.tsx":
      '<p className="text-sm">fine</p>\n<h1 className="text-[clamp(2rem,5vw,4rem)]">x</h1>\n',
  });
  assert.equal(status, 0);
  assert.match(output, /No absolute-px font sizes found/);
});
