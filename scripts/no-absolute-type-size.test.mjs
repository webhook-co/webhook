import assert from "node:assert/strict";
import { test } from "node:test";

import { findAbsoluteTypeSizes } from "./no-absolute-type-size.mjs";

const find = (line) => findAbsoluteTypeSizes(line, "x.tsx", 1);

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
