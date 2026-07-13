#!/usr/bin/env node
// CLI DISTRIBUTION-CHANNEL PARITY.
//
// `wbhk` ships through three channels: npm, Homebrew, and the raw binaries on the GitHub release. They can
// SILENTLY diverge, and did:
//
//   `release-cli` publishes to npm IMMEDIATELY, but deliberately leaves the GitHub release as a DRAFT (a
//   human gate). `homebrew-bump` only fires on `release: published`. So tagging cli-v0.3.0 shipped npm 0.3.0
//   while Homebrew stayed on 0.2.0 — and NOTHING complained. A brew user running `wbhk -v` saw 0.2.0, ran
//   `brew upgrade`, and got... 0.2.0. The newest thing brew could give them was already installed.
//
// It is the same shape as every other bug this week: a DERIVED artifact (the tap formula) whose update is not
// wired to its SOURCE (the release tag). The fix is not to remove the human gate — it exists for a reason —
// but to make forgetting it impossible to miss.
//
// Fails when npm is AHEAD of Homebrew. Not when Homebrew is ahead (that cannot happen through the pipeline)
// and not when they match.
//
// Run: node scripts/check-cli-channels.mjs

import { pathToFileURL } from "node:url";

const TAP_FORMULA =
  "https://raw.githubusercontent.com/webhook-co/homebrew-tap/main/Formula/wbhk.rb";

/**
 * Pull the version out of a Homebrew formula. Exported for tests: a guard whose parser is untested is a
 * guard that quietly returns null and passes forever.
 */
export function parseFormulaVersion(rubySource) {
  const match = /^\s*version\s+"([^"]+)"/m.exec(rubySource);
  return match === null ? null : match[1];
}

/** -1 / 0 / 1, numeric per part. "0.10.0" > "0.9.0" — as a STRING it is not. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** The check, as a pure function of the two versions. Returns an error string, or null when all is well. */
export function checkChannels(npmVersion, brewVersion) {
  if (brewVersion === null) {
    return "could not read a version out of the Homebrew formula — the parser or the formula changed shape";
  }
  if (compareVersions(npmVersion, brewVersion) <= 0) return null;
  return (
    `npm serves ${npmVersion} but Homebrew still serves ${brewVersion}.\n` +
    "The cli-v* GitHub release is probably still a DRAFT: release-cli publishes npm immediately but leaves\n" +
    "the release unpublished, and homebrew-bump only fires on `release: published`. Every brew user is\n" +
    `stranded on ${brewVersion} until someone publishes it.\n` +
    "Fix: gh release edit cli-v<version> --draft=false   (this fires homebrew-bump)"
  );
}

async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) throw new Error(`npm ${pkg}: HTTP ${res.status}`);
  return (await res.json()).version;
}

async function brewLatest() {
  const res = await fetch(TAP_FORMULA);
  if (!res.ok) throw new Error(`homebrew tap formula: HTTP ${res.status}`);
  return parseFormulaVersion(await res.text());
}

async function run() {
  const [npmVersion, brewVersion] = await Promise.all([npmLatest("@webhook-co/cli"), brewLatest()]);
  console.log(`  npm:      ${npmVersion}`);
  console.log(`  homebrew: ${brewVersion ?? "(unparseable)"}`);

  const problem = checkChannels(npmVersion, brewVersion);
  if (problem !== null) {
    console.error(`\n::error::CLI channels have diverged.\n${problem}`);
    process.exit(1);
  }
  console.log("\nnpm and Homebrew serve the same CLI version.");
}

// Only when invoked directly — importing this (the tests do) must not fire live requests or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
