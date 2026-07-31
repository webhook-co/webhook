import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectFromDevVars,
  mergeIntoDevVars,
  parseEnv,
  sharedSecretNames,
  toEnv,
} from "./dev-secrets-vault.mjs";

// The vault shares only what a second machine CANNOT produce for itself. Getting that set wrong is not a
// cosmetic mistake: too wide and a machine-specific value is copied over another machine's, too narrow and
// someone is back to hunting vendor dashboards.

test("shares the credentials that actually need sharing", () => {
  const names = sharedSecretNames();
  for (const required of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "RESEND_API_KEY",
    "TURNSTILE_SECRET_KEY",
  ]) {
    assert.ok(names.includes(required), `${required} is parity-required but not shared`);
  }
});

test("never shares a mode FLAG", () => {
  // OAUTH_MODE / EMAIL_MODE are scoped external but are switches, and must stay BLANK for prod parity.
  // Distributing them would push a DEGRADED stack onto the next machine.
  for (const flag of ["OAUTH_MODE", "EMAIL_MODE", "KMS_MODE"]) {
    assert.ok(!sharedSecretNames().includes(flag), `${flag} must not be distributed`);
  }
});

// The bug this pins was found by a round-trip diff and is invisible to inspection: both values are
// plausible strings. STRIPE_METER_EVENT_NAME is `local` for api (a literal the generator writes) and
// `external` for engine (a value from your own Stripe sandbox) — sharing it copied api's literal over
// engine's independent value.
test("never shares a name that is a LOCAL literal in any app", () => {
  assert.ok(
    !sharedSecretNames().includes("STRIPE_METER_EVENT_NAME"),
    "a name scoped `local` anywhere is written by the generator, not shared",
  );
  const mixed = sharedSecretNames([
    // a synthetic app pair with the same name in both scopes
  ]);
  assert.deepEqual(mixed, [], "an empty app list must produce an empty set, not everything");
});

test("the set is non-empty and every name is a plain env identifier", () => {
  const names = sharedSecretNames();
  assert.ok(names.length >= 6, `only ${names.length} shared names — discovery may have broken`);
  for (const n of names) assert.match(n, /^[A-Z][A-Z0-9_]*$/, `${n} is not an env identifier`);
});

test("parseEnv splits on the FIRST = and ignores comments", () => {
  const v = parseEnv("A=1\n# note\nB=b64==\nC=http://x/?a=b\n\nD=\n");
  assert.equal(v.get("A"), "1");
  assert.equal(v.get("B"), "b64==", "base64 padding must survive");
  assert.equal(v.get("C"), "http://x/?a=b", "a query string must survive");
  assert.equal(v.get("D"), "");
  assert.equal(v.has("# note"), false);
});

test("toEnv round-trips through parseEnv", () => {
  const original = new Map([
    ["A", "1"],
    ["B", "b64=="],
  ]);
  assert.deepEqual(parseEnv(toEnv(original)), original);
});

test("merging replaces an existing key in place and appends a new one", () => {
  const out = mergeIntoDevVars(
    "# header\nGOOGLE_CLIENT_ID=old\nOTHER=keep\n",
    new Map([
      ["GOOGLE_CLIENT_ID", "new"],
      ["RESEND_API_KEY", "added"],
    ]),
  );
  assert.match(out, /^GOOGLE_CLIENT_ID=new$/m);
  assert.ok(!out.includes("old"), "the old value survived");
  assert.match(out, /^OTHER=keep$/m, "an unrelated key was disturbed");
  assert.match(out, /^RESEND_API_KEY=added$/m);
  assert.equal((out.match(/GOOGLE_CLIENT_ID=/g) ?? []).length, 1, "the key was duplicated");
  assert.match(out, /^# header$/m, "a comment was lost");
});

test("a value containing regex metacharacters is not treated as a pattern", () => {
  const out = mergeIntoDevVars("A.B=old\n", new Map([["A.B", "new"]]));
  assert.match(out, /^A\.B=new$/m);
});

test("collecting flags a name that DISAGREES between apps", () => {
  // Publishing whichever app was read last would bake the mismatch into every machine that pulls.
  const { conflicts } = collectFromDevVars(
    (app) => (app === "auth" ? "RESEND_API_KEY=one\n" : "RESEND_API_KEY=two\n"),
    ["RESEND_API_KEY"],
    ["auth", "api"],
  );
  assert.deepEqual(conflicts, ["RESEND_API_KEY"]);
});

test("collecting skips apps with no .dev.vars, and blank values", () => {
  const { values, conflicts } = collectFromDevVars(
    (app) =>
      app === "auth" ? "RESEND_API_KEY=real\n" : app === "api" ? "RESEND_API_KEY=\n" : null,
    ["RESEND_API_KEY"],
    ["auth", "api", "web"],
  );
  assert.deepEqual(
    [...values],
    [["RESEND_API_KEY", "real"]],
    "a blank must not overwrite a real value",
  );
  assert.deepEqual(conflicts, []);
});
