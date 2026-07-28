import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { datadirVersionFault, readDatadirVersion, RECOVERY_COMMAND } from "./dev-db-preflight.mjs";

// The defect this guards: scripts/dev-db.sh skips initdb whenever .dev-pg exists, then starts that
// datadir with the pinned major's pg_ctl. When #734 moved PG_MAJOR 14 → 17, every pre-existing
// cluster began failing with a raw `FATAL: database files are incompatible with server` and no hint
// that `nuke` is the fix. The version pair is pure data, so the decision belongs in a tested module
// rather than in bash.

test("no fault when the datadir matches the pinned major", () => {
  assert.equal(datadirVersionFault({ datadirVersion: "17", expectedMajor: 17 }), null);
});

test("no fault when there is no datadir yet — initdb will create it", () => {
  assert.equal(datadirVersionFault({ datadirVersion: null, expectedMajor: 17 }), null);
});

test("trailing newline in PG_VERSION does not read as a mismatch", () => {
  // initdb writes "17\n". Comparing the raw file contents would fault on every single run.
  assert.equal(datadirVersionFault({ datadirVersion: "17\n", expectedMajor: 17 }), null);
  assert.equal(datadirVersionFault({ datadirVersion: "  17  \n", expectedMajor: 17 }), null);
});

test("reports a mismatch when the datadir predates the pinned major", () => {
  const fault = datadirVersionFault({ datadirVersion: "14", expectedMajor: 17 });
  assert.ok(fault, "expected a fault for a PG14 datadir under a PG17 pin");
  assert.equal(fault.found, "14");
  assert.equal(fault.expected, 17);
});

test("the message names both versions and the exact recovery command", () => {
  // The whole point is that the operator does not have to guess. A message that says only
  // "incompatible" is the failure we already have.
  const fault = datadirVersionFault({ datadirVersion: "14", expectedMajor: 17 });
  assert.match(fault.message, /\b14\b/);
  assert.match(fault.message, /\b17\b/);
  assert.ok(
    fault.message.includes(RECOVERY_COMMAND),
    `message must include the recovery command, got: ${fault.message}`,
  );
});

test("the recovery command is the destructive-reset path, spelled out", () => {
  assert.match(RECOVERY_COMMAND, /nuke/);
});

test("the message warns that recovery destroys local data", () => {
  // `nuke` deletes the cluster and there is no seed, so whatever was in there is gone. Saying so is
  // the difference between an informed reset and a surprise.
  const fault = datadirVersionFault({ datadirVersion: "14", expectedMajor: 17 });
  assert.match(fault.message, /delet|destroy|lose|lost/i);
});

test("a newer datadir than the pin also faults", () => {
  // Postgres refuses both directions. Someone who ran a newer brew Postgres against .dev-pg lands
  // here, and the same reset is the fix.
  const fault = datadirVersionFault({ datadirVersion: "18", expectedMajor: 17 });
  assert.ok(fault);
  assert.equal(fault.found, "18");
});

test("unreadable PG_VERSION content fails closed rather than passing", () => {
  // An empty or garbage PG_VERSION means the datadir is not something we can reason about. Starting
  // it anyway reproduces the opaque failure this module exists to prevent.
  for (const bad of ["", "   ", "not-a-number", "17abc"]) {
    const fault = datadirVersionFault({ datadirVersion: bad, expectedMajor: 17 });
    assert.ok(fault, `expected a fault for PG_VERSION contents ${JSON.stringify(bad)}`);
  }
});

test("expectedMajor must be a positive integer", () => {
  // Guards against a bash typo silently disabling the check by passing an empty PG_MAJOR.
  for (const bad of [undefined, null, "", "abc", 0, -1, 17.5]) {
    assert.throws(
      () => datadirVersionFault({ datadirVersion: "17", expectedMajor: bad }),
      /expectedMajor/,
      `expected a throw for expectedMajor ${JSON.stringify(bad)}`,
    );
  }
});

test("a numeric-string expectedMajor is accepted — bash has no integers", () => {
  assert.equal(datadirVersionFault({ datadirVersion: "17", expectedMajor: "17" }), null);
  assert.ok(datadirVersionFault({ datadirVersion: "14", expectedMajor: "17" }));
});

// --- readDatadirVersion ------------------------------------------------------------------------
//
// This half of the module has the I/O and had no tests, which is how the hole below survived: a bare
// `catch { return null }` conflated "no datadir, initdb will create it" with "a datadir exists that I
// cannot read". dev-db.sh keys initdb off `[ ! -d "$PGDATA" ]`, so for a directory that exists with an
// absent or unreadable PG_VERSION the script SKIPS initdb and then dies on the very opaque pg_ctl error
// this module exists to prevent — reached through the module's own happy path.

test("returns null only when the datadir itself is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "devdb-"));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(readDatadirVersion(dir), null);
  assert.equal(
    datadirVersionFault({ datadirVersion: readDatadirVersion(dir), expectedMajor: 17 }),
    null,
  );
});

test("reads the version from a datadir that has one", () => {
  const dir = mkdtempSync(join(tmpdir(), "devdb-"));
  try {
    writeFileSync(join(dir, "PG_VERSION"), "17\n");
    assert.equal(readDatadirVersion(dir).trim(), "17");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a datadir that EXISTS but has no PG_VERSION faults — it must not read as 'absent'", () => {
  // The regression: an interrupted `nuke`, a partial rm -rf, or a datadir copied without hidden files.
  const dir = mkdtempSync(join(tmpdir(), "devdb-"));
  try {
    const found = readDatadirVersion(dir);
    assert.notEqual(found, null, "an existing datadir must never report as absent");
    const fault = datadirVersionFault({ datadirVersion: found, expectedMajor: 17 });
    assert.ok(fault, "an unreadable existing datadir must fault");
    assert.ok(fault.message.includes(RECOVERY_COMMAND));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PG 9.x datadir reports a version mismatch, not an unreadable file", () => {
  // PG_VERSION was "9.6" before the single-number scheme. The recovery is the same either way, but the
  // reason should be true.
  const fault = datadirVersionFault({ datadirVersion: "9.6", expectedMajor: 17 });
  assert.ok(fault);
  assert.equal(fault.found, "9.6");
  assert.match(fault.message, /9\.6/);
  assert.doesNotMatch(fault.message, /unreadable/i);
});

test("expectedMajor is validated on its string shape, not a coerced number", () => {
  // Number("0x11") is 17 and Number(" 17 ") is 17; neither is a plausible PG_MAJOR line in bash.
  for (const bad of ["0x11", " 17 ", "1e1"]) {
    assert.throws(
      () => datadirVersionFault({ datadirVersion: "17", expectedMajor: bad }),
      /expectedMajor/,
    );
  }
});
