import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPS_COVERED,
  APPS_NEEDING_SECRETS,
  findings,
  isRelaxed,
  parseDevVars,
  requiredSpecs,
} from "./dev-preflight.mjs";
import { APP_NAMES, specsFor } from "./dev-secrets-manifest.mjs";
import { renderExample } from "./dev-secrets.mjs";

// What this prevents: a clone with no `.dev.vars` boots, serves a login page that renders perfectly,
// and simply offers fewer ways in — because the page derives its buttons from which OAuth secrets are
// PRESENT. Nothing errors, so nothing tells you. `pnpm dev` printing "ready" while the stack is
// quietly less than production is the failure this whole lane exists to eliminate.

test("parseDevVars reads keys and treats blank as absent", () => {
  const vars = parseDevVars("A=1\nB=\n# comment\n\nC = spaced \n");
  assert.equal(vars.get("A"), "1");
  assert.equal(vars.get("B"), "");
  assert.equal(vars.get("C"), "spaced");
  assert.equal(vars.has("# comment"), false);
});

test("parseDevVars keeps '=' inside a value", () => {
  // base64 secrets end in '=' padding; splitting on every '=' would silently truncate them.
  const vars = parseDevVars("KEY=abc==\nURL=http://x/?a=b\n");
  assert.equal(vars.get("KEY"), "abc==");
  assert.equal(vars.get("URL"), "http://x/?a=b");
});

test("parseDevVars strips surrounding quotes but not inner ones", () => {
  const vars = parseDevVars(`A="q"\nB='s'\nC=in"ner\n`);
  assert.equal(vars.get("A"), "q");
  assert.equal(vars.get("B"), "s");
  assert.equal(vars.get("C"), 'in"ner');
});

test("apps needing secrets are DISCOVERED from the manifest, not hand-listed", () => {
  assert.ok(
    APPS_NEEDING_SECRETS.length >= 5,
    `expected ≥5 apps, got ${APPS_NEEDING_SECRETS.length}`,
  );
  for (const expected of ["auth", "api", "engine", "web", "mcp"]) {
    assert.ok(
      APPS_NEEDING_SECRETS.includes(expected),
      `${expected} missing: ${APPS_NEEDING_SECRETS}`,
    );
  }
});

test("auth's required set includes the OAuth pair and names its opt-out flag", () => {
  const byName = new Map(requiredSpecs("auth").map((s) => [s.name, s]));
  for (const n of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID"]) {
    assert.ok(byName.has(n), `${n} not in auth's required set`);
    assert.equal(byName.get(n).relaxedBy.name, "OAUTH_MODE");
  }
});

test("a set flag relaxes its secrets; a different value does NOT", () => {
  const spec = { name: "GOOGLE_CLIENT_ID", relaxedBy: { name: "OAUTH_MODE", value: "optional" } };
  assert.equal(isRelaxed(spec, new Map([["OAUTH_MODE", "optional"]])), true);
  assert.equal(isRelaxed(spec, new Map([["OAUTH_MODE", "OPTIONAL"]])), true, "case-insensitive");
  assert.equal(
    isRelaxed(spec, new Map([["OAUTH_MODE", ""]])),
    false,
    "blank is strict, not opt-out",
  );
  assert.equal(
    isRelaxed(spec, new Map([["OAUTH_MODE", "yes"]])),
    false,
    "wrong value is not opt-out",
  );
  assert.equal(isRelaxed(spec, new Map()), false, "absent flag is strict");
});

// The exact shape of the founder's bug: the file did not exist at all.
test("a MISSING .dev.vars file is reported, not skipped", () => {
  const out = findings([{ app: "auth", exists: false, source: "" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].app, "auth");
  assert.equal(out[0].kind, "missing-file");
});

test("a present-but-blank required secret is reported", () => {
  const out = findings([
    { app: "auth", exists: true, source: "GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=x\n" },
  ]);
  const names = out.flatMap((f) => f.missing ?? []);
  assert.ok(names.includes("GOOGLE_CLIENT_ID"), `expected GOOGLE_CLIENT_ID in ${names}`);
  assert.ok(!names.includes("GOOGLE_CLIENT_SECRET"), "a SET secret must not be reported");
});

test("setting the opt-out flag clears the finding for its secrets", () => {
  const strict = findings([{ app: "auth", exists: true, source: "OAUTH_MODE=\n" }]);
  const relaxed = findings([{ app: "auth", exists: true, source: "OAUTH_MODE=optional\n" }]);
  const strictNames = strict.flatMap((f) => f.missing ?? []);
  const relaxedNames = relaxed.flatMap((f) => f.missing ?? []);
  assert.ok(strictNames.includes("GOOGLE_CLIENT_ID"), "strict mode must demand the OAuth pair");
  assert.ok(!relaxedNames.includes("GOOGLE_CLIENT_ID"), "OAUTH_MODE=optional must waive it");
  // ...but a DIFFERENT secret's requirement must survive — the flag relaxes only what it names.
  assert.ok(
    relaxedNames.includes("RESEND_API_KEY"),
    "OAUTH_MODE must not waive EMAIL_MODE's secrets",
  );
});

test("a fully-populated app produces NO findings (the guard can pass)", () => {
  const source = requiredSpecs("auth")
    .map((s) => `${s.name}=value`)
    .join("\n");
  assert.deepEqual(findings([{ app: "auth", exists: true, source }]), []);
});

// Anti-vacuity: if findings() returned [] unconditionally every assertion above about a POPULATED
// app would still pass, and the check would be decorative.
test("the check is not vacuous — an empty file yields findings for every app", () => {
  const entries = APPS_NEEDING_SECRETS.map((app) => ({ app, exists: true, source: "" }));
  const out = findings(entries);
  assert.equal(out.length, APPS_NEEDING_SECRETS.length, "every app should report something");
  for (const f of out)
    assert.ok((f.missing ?? []).length > 0, `${f.app} reported no missing names`);
});

// --- Coverage of the derived app lists ----------------------------------------------------------
// These constants used to be `[...APP_NAMES]` and the tests asserted `length >= 5`, which stayed true
// while six apps were missing from the manifest entirely. A floor cannot notice an omission.

test("apps that declare secrets are required; apps that declare none are not", () => {
  // play joined this list when its Turnstile challenge was turned on locally — it needs the
  // `webhook-play mint` widget's OWN secret, which is not auth's value despite the identical name.
  for (const app of ["dmarc", "health", "play"]) {
    assert.ok(
      APPS_NEEDING_SECRETS.includes(app),
      `${app} declares secrets but is not required to have them`,
    );
  }
  for (const app of ["www", "get", "telemetry"]) {
    assert.ok(
      !APPS_NEEDING_SECRETS.includes(app),
      `${app} needs no secrets but is required to supply some`,
    );
  }
});

test("the denominator is every app the manifest covers", () => {
  assert.deepEqual([...APPS_COVERED].sort(), [...APP_NAMES].sort());
  assert.ok(
    APPS_COVERED.length > APPS_NEEDING_SECRETS.length,
    "no app needs nothing — is coverage a subset again?",
  );
});

test("dmarc's Resend key is ENFORCED, not merely described as required", () => {
  // The note said "REQUIRED for prod parity" while the flag was absent, so preflight waved a blank key
  // through and the Resend 401 stayed reachable — a claim outrunning the code.
  const spec = requiredSpecs("dmarc").find((s) => s.name === "RESEND_API_KEY");
  assert.ok(spec, "a blank RESEND_API_KEY would still start `pnpm dev` for dmarc");
  assert.deepEqual(
    spec.relaxedBy,
    { name: "EMAIL_MODE", value: "log" },
    "an external must have an opt-out",
  );
  assert.ok(isRelaxed(spec, new Map([["EMAIL_MODE", "log"]])), "the opt-out does not relax it");
  assert.ok(!isRelaxed(spec, new Map([["EMAIL_MODE", ""]])), "a blank flag must NOT relax it");
});

// play's Turnstile gate, mirroring the dmarc Resend test. Membership in APPS_NEEDING_SECRETS cannot catch
// a dropped `parityRequired`, a wrong `relaxedBy`, or TURNSTILE_MODE=on with a blank secret sailing past.
test("play's Turnstile secret is ENFORCED when the challenge is on", () => {
  const spec = requiredSpecs("play").find((s) => s.name === "TURNSTILE_SECRET_KEY");
  assert.ok(spec, "a blank play Turnstile secret would still start `pnpm dev`");
  assert.deepEqual(spec.relaxedBy, { name: "TURNSTILE_MODE", value: "off" });

  const on = new Map([
    ["TURNSTILE_MODE", "on"],
    ["TURNSTILE_SECRET_KEY", ""],
  ]);
  assert.ok(!isRelaxed(spec, on), "mode=on must NOT relax the secret — that is the parity path");

  const off = new Map([
    ["TURNSTILE_MODE", "off"],
    ["TURNSTILE_SECRET_KEY", ""],
  ]);
  assert.ok(isRelaxed(spec, off), "a contributor with no play secret has no way through");
});

test("a blank play secret with the challenge ON is reported by findings()", () => {
  const problems = findings([
    { app: "play", exists: true, source: "TURNSTILE_MODE=on\nTURNSTILE_SECRET_KEY=\n" },
  ]);
  const missing = problems.flatMap((p) => p.missing ?? []);
  assert.ok(
    missing.includes("TURNSTILE_SECRET_KEY"),
    "the playground would mint with an unverifiable challenge and nothing would say so",
  );
});

// The engine's KEK custodian, mirroring the dmarc Resend and play Turnstile pins. This PR's load-bearing
// change is that real AWS KMS is now the local DEFAULT — drop `parityRequired` or break `relaxedBy` and
// local dev silently returns to sealing under a throwaway KEK, with the vault, example and kms-provider
// suites all still green. The runtime fence does not help: it only fires once a provider is constructed.
const AWS_KMS_SPECS = ["KMS_KEY_ARN", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

test("every AWS KMS field is ENFORCED for the engine, with the same opt-out", () => {
  const required = requiredSpecs("engine");
  for (const name of AWS_KMS_SPECS) {
    const spec = required.find((s) => s.name === name);
    assert.ok(spec, `${name} blank would still start \`pnpm dev\` — local would not use real KMS`);
    assert.deepEqual(
      spec.relaxedBy,
      { name: "KMS_MODE", value: "local" },
      `${name} must be relaxed by the documented opt-out and nothing else`,
    );
  }
});

test("a blank KMS_MODE means REAL AWS, so the four fields are demanded", () => {
  // Blank is the parity path here, which inverts the usual convention — the substitute is the flag, not
  // its absence. If blank started relaxing them, the default would quietly become the throwaway KEK again.
  const problems = findings([{ app: "engine", exists: true, source: "KMS_MODE=\n" }]);
  const missing = problems.flatMap((p) => p.missing ?? []);
  for (const name of AWS_KMS_SPECS) {
    assert.ok(missing.includes(name), `${name} was not demanded when KMS_MODE is blank`);
  }
});

test("KMS_MODE=local is the ONLY thing that relaxes them", () => {
  const spec = requiredSpecs("engine").find((s) => s.name === "KMS_KEY_ARN");
  assert.ok(
    isRelaxed(spec, new Map([["KMS_MODE", "local"]])),
    "the documented opt-out does not work",
  );
  assert.ok(
    !isRelaxed(spec, new Map([["KMS_MODE", ""]])),
    "blank must NOT relax — blank is the parity path",
  );
  assert.ok(
    !isRelaxed(spec, new Map([["KMS_MODE", "aws"]])),
    "an unrecognised value must not relax either",
  );
});

// The SHIPPED DEFAULT, which the tests above do not cover.
//
// They pin that the four AWS fields are required and that only `KMS_MODE=local` relaxes them. None of
// that notices if the manifest goes back to `{ scope: "local", value: "local" }`: `pnpm dev:secrets` would
// then WRITE `KMS_MODE=local` into every .dev.vars, preflight would relax all four, the engine would use
// the hermetic KEK again — and all three tests above would still pass. The regression is in what we ship,
// not in what we enforce.
test("the engine ships KMS_MODE BLANK — local is an opt-out, never the default", () => {
  const spec = specsFor("engine").find((s) => s.name === "KMS_MODE");
  assert.ok(spec, "the engine no longer declares KMS_MODE at all");
  assert.equal(
    spec.scope,
    "external",
    "a `local` scope makes the generator write a value, not a blank",
  );
  assert.notEqual(
    spec.value,
    "local",
    "shipping `local` puts every machine back on the throwaway KEK",
  );

  // The rendered artifact, not just the spec: this is what actually lands in a developer's .dev.vars.
  const line = renderExample("engine")
    .split("\n")
    .find((l) => l.startsWith("KMS_MODE="));
  assert.equal(
    line,
    "KMS_MODE=",
    `the generated example ships "${line}" — the substitute, by default`,
  );
});
