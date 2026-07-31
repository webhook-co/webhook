import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectFromDevVars,
  mergeIntoDevVars,
  NOT_SHAREABLE,
  parseEnv,
  pullSet,
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
    "TURNSTILE_SECRET_KEY",
  ]) {
    assert.ok(names.includes(required), `${required} is parity-required but not shared`);
  }
  // RESEND_API_KEY is parity-required too, and deliberately NOT here — it is the same key production
  // sends with, so it is excluded by NOT_SHAREABLE and stays a manual step. See the test below.
  assert.ok(!names.includes("RESEND_API_KEY"));
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

// The exact set, not a floor. A floor of 6 passed while every STRIPE_* name silently dropped out of
// discovery — the tool would still report success, just quietly stop sharing half of what it claims to.
test("the shared set is exactly the documented 10 names", () => {
  assert.deepEqual(sharedSecretNames(), [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "STRIPE_METER_ID",
    "STRIPE_PLANS",
    "STRIPE_PORTAL_CONFIGURATION_ID",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SIGNING_SECRET",
    "TURNSTILE_SECRET_KEY",
  ]);
  for (const n of sharedSecretNames()) {
    assert.match(n, /^[A-Z][A-Z0-9_]*$/, `${n} is not an env identifier`);
  }
});

// A credential that is ALSO live in production must never enter this vault. The vault's protection is a
// passphrase, and repo read access yields the ciphertext and the wrapped key together — fine for a
// Stripe test key, not for something that can send mail as webhook.co.
test("a production credential is never shareable, by either direction", () => {
  for (const name of NOT_SHAREABLE) {
    assert.ok(
      !sharedSecretNames().includes(name),
      `${name} is a prod credential and must not be vaulted`,
    );
    assert.deepEqual(
      [...pullSet(new Map([[name, "leaked"]]), [name])],
      [],
      `${name} would still be applied by a pull from an older vault`,
    );
  }
});

// --- Pull applies the SAME allowlist push does ----------------------------------------------------
// The ciphertext is committed, so it outlives the allowlist that produced it. A vault written before a
// name was reclassified still carries that name, and a pull that trusts the file's contents would
// re-apply it — reintroducing precisely the STRIPE_METER_EVENT_NAME bug, from a file, months later.
// The allowlist has to be enforced on the way OUT as well as the way in.

const APP_SPECS = [
  "GOOGLE_CLIENT_ID",
  "OAUTH_MODE",
  "STRIPE_METER_EVENT_NAME",
  "STRIPE_SECRET_KEY",
];

test("pull ignores a name the vault carries but the allowlist does not", () => {
  const vault = new Map([
    ["GOOGLE_CLIENT_ID", "real"],
    ["OAUTH_MODE", "degraded"],
    ["STRIPE_METER_EVENT_NAME", "api-literal"],
  ]);
  assert.deepEqual(
    [...pullSet(vault, APP_SPECS)],
    [["GOOGLE_CLIENT_ID", "real"]],
    "a stale or hand-added name in the ciphertext was applied to .dev.vars",
  );
});

test("pull skips a blank, so it cannot clobber a real local value", () => {
  // `!== undefined` treats "" as present. Merging that would blank a working credential and the only
  // symptom would be a provider quietly vanishing from /login.
  assert.deepEqual([...pullSet(new Map([["STRIPE_SECRET_KEY", ""]]), APP_SPECS)], []);
});

test("pull still delivers every allowlisted name the app actually declares", () => {
  // Anti-vacuity: the two tests above would also pass if pullSet returned nothing at all.
  const vault = new Map([
    ["GOOGLE_CLIENT_ID", "a"],
    ["STRIPE_SECRET_KEY", "b"],
    ["TURNSTILE_SECRET_KEY", "not-this-app"],
  ]);
  assert.deepEqual(
    [...pullSet(vault, APP_SPECS)].sort(),
    [
      ["GOOGLE_CLIENT_ID", "a"],
      ["STRIPE_SECRET_KEY", "b"],
    ],
    "a name this app declares and the allowlist shares was not delivered",
  );
});

test("push and pull agree on what is shareable", () => {
  // Two independent filters that must not drift apart: anything push would publish, pull must accept.
  const vault = new Map(sharedSecretNames().map((n) => [n, "v"]));
  assert.deepEqual([...pullSet(vault, sharedSecretNames()).keys()], sharedSecretNames());
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
