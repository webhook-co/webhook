#!/usr/bin/env node
// The shared local-dev credentials, encrypted at rest in the private `internal` repo.
//
// WHAT THIS IS FOR, and what it deliberately is NOT. Of the values `pnpm dev:secrets` writes, most need no
// sharing at all: the `generated` ones are random per machine, and the `local` ones are non-secret literals
// already in the committed examples. What is left is nine real third-party credentials — the Google and
// GitHub OAuth pairs, Turnstile, and the Stripe test-mode values. Those are the only thing a second machine
// cannot produce for itself, and hunting four vendor dashboards is the friction this removes.
//
// TWO credentials are deliberately NOT carried, for two different reasons — see NOT_SHAREABLE. Read it
// before adding anything: "is it a secret" is the wrong question, "what does it open, and is it the same
// value on every machine" is the right one.
//
// WHY ENCRYPTED RATHER THAN A PLAIN FILE IN A PRIVATE REPO. GitHub secret scanning runs on this org with
// push protection on, and vendors participate in that programme, so committing a live key can get it
// revoked BY THE VENDOR — a production incident caused by a convenience commit. It is also the thing
// AGENTS.md names outright: secrets never in source or plaintext config. Ciphertext is the only form git
// should ever see.
//
// THE KEY. sops+age uses a keypair. The PUBLIC key is a recipient and belongs in `.sops.yaml`, committed.
// The PRIVATE key is wrapped with a passphrase (`age -p`) and committed too, so everything lives in the one
// internal repo and the passphrase is the only thing carried out of band.
//
//   ⚠️ That means repo read access yields both the ciphertext AND the wrapped key, so an attacker can
//   attack the passphrase offline. The passphrase is doing all the work: use five or six random words,
//   and nothing you have typed anywhere else. This is a deliberate trade for keeping one repo, and it is
//   why a credential with production blast radius must never go in here.
//
// Commands (init/unlock are INTERACTIVE — age reads the passphrase from the terminal, never from a flag,
// an env var, or this script):
//   --init     generate the keypair, wrap it, write .sops.yaml + the wrapped key   (once, ever)
//   --unlock   unwrap the private key onto this machine                            (once per machine)
//   --push     encrypt the credentials from your .dev.vars into the internal repo
//   --pull     decrypt them back into every app's .dev.vars
//
// No secret VALUE is ever printed — only names, and whether each is present.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAMES, specsFor } from "./dev-secrets-manifest.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The private `internal` checkout, resolved from the path of the MAIN `.git` directory.
 *
 * `internal` sits beside the main checkout, but almost all work here happens in git worktrees under
 * `.claude/worktrees/`. Resolving `../internal` from wherever this script happens to live puts it at
 * `.claude/worktrees/internal`, which exists nowhere — so the vault worked in the main checkout and failed
 * in every worktree, with an error blaming the clone rather than the lookup.
 *
 * `git rev-parse --git-common-dir` reports the MAIN `.git` from any worktree, so its parent is the one
 * anchor that does not move. Pure and separately testable, because the bug was entirely in the arithmetic.
 */
export function internalRepoFrom(gitCommonDir, env = process.env) {
  if (env.WEBHOOK_INTERNAL_REPO) return env.WEBHOOK_INTERNAL_REPO;
  return resolve(dirname(gitCommonDir), "..", "internal");
}

/** As above, asking git where the main checkout is; falls back to this file's location outside a repo. */
export function internalRepo(env = process.env) {
  if (env.WEBHOOK_INTERNAL_REPO) return env.WEBHOOK_INTERNAL_REPO;
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPO,
    encoding: "utf8",
  });
  const common = res.status === 0 ? res.stdout.trim() : "";
  return common ? internalRepoFrom(common, env) : resolve(REPO, "..", "internal");
}

export const SOPS_CONFIG = (internal) => join(internal, ".sops.yaml");
export const CIPHERTEXT = (internal) => join(internal, "secrets", "dev-secrets.enc.env");
export const WRAPPED_KEY = (internal) => join(internal, "secrets", "age-key.txt.age");
export const LOCAL_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");

/**
 * The environment every `sops` call runs with — pinning SOPS_AGE_KEY_FILE to the key we actually wrote.
 *
 * sops resolves its default age key path with Go's `os.UserConfigDir`, which is
 * `~/Library/Application Support/sops/age` on macOS and `~/.config/sops/age` on Linux. This script writes
 * the key to ONE path on every platform, so on macOS sops looked somewhere the key had never been and
 * `--pull` failed with "identity did not match any of the recipients" — a message that points at the key
 * being WRONG when it was merely elsewhere. Telling sops the location outright is both platform-proof and
 * a great deal easier to read than a per-OS path table.
 *
 * A caller who already set SOPS_AGE_KEY_FILE keeps it: someone whose identity lives somewhere else should
 * not have it silently replaced by ours.
 */
export function sopsEnv(env = process.env) {
  return { ...env, SOPS_AGE_KEY_FILE: env.SOPS_AGE_KEY_FILE ?? LOCAL_KEY };
}

/**
 * The secret names worth sharing: `external` everywhere they appear, and not a mode flag.
 *
 * Two exclusions, both load-bearing:
 *
 *  - **mode FLAGS.** `OAUTH_MODE` and `EMAIL_MODE` are scoped external because they concern a third party,
 *    but they are switches, not credentials — and they must stay BLANK for prod parity. Distributing them
 *    would push a degraded stack onto the next machine.
 *
 *  - **anything scoped `local` in ANY app.** `STRIPE_METER_EVENT_NAME` is `local` for api (a fixed literal
 *    `pnpm dev:secrets` writes) and `external` for engine (a value from your own Stripe sandbox). Sharing
 *    it copied api's literal over engine's independent value — caught by a round-trip diff, invisible
 *    otherwise, because both are plausible strings. A name that is a literal SOMEWHERE is never a shared
 *    credential; the generator already writes it.
 *
 *  - **anything that is also a PRODUCTION credential.** See NOT_SHAREABLE below.
 *
 * Derived from the manifest, never a second list.
 */
export function sharedSecretNames(appNames = APP_NAMES) {
  const scopes = new Map();
  for (const app of appNames) {
    for (const spec of specsFor(app)) {
      if (!scopes.has(spec.name)) scopes.set(spec.name, new Set());
      scopes.get(spec.name).add(spec.scope);
    }
  }
  return [...scopes]
    .filter(
      ([name, seen]) =>
        seen.has("external") &&
        !seen.has("local") &&
        !name.endsWith("_MODE") &&
        !NOT_SHAREABLE.has(name),
    )
    .map(([name]) => name)
    .sort();
}

/**
 * Credentials this vault refuses to carry, and WHY — the reason is the point, because the two exclusions
 * below fail for completely different reasons and a bare name list would flatten that into "don't".
 *
 * Removing an entry here is a decision about blast radius or about machine-scope. It is never a cleanup.
 */
export const NOT_SHAREABLE = new Map([
  [
    "RESEND_API_KEY",
    // Blast radius. The vault's protection is a passphrase, and repo read access yields the ciphertext AND
    // the wrapped key together — so the passphrase is the only thing between a repo reader and this
    // capability, attackable offline. Fine for a Stripe TEST key or an OAuth client whose callbacks are
    // localhost; not fine for one that can send mail as webhook.co. Compliance-by-design says production
    // secrets live in a KMS, and an offline-attackable git blob is not one.
    "it is the same key production sends with — a prod capability does not belong in a passphrase-protected git blob",
  ],
  [
    "STRIPE_WEBHOOK_SIGNING_SECRET",
    // Machine scope. A registered Stripe endpoint POSTs to a public URL and can never reach localhost, so
    // the local receiver is fed by the CLI's outbound tunnel and `.dev.vars` holds the CLI's OWN whsec_
    // (`stripe listen --print-secret`). Distributing one machine's value hands every other machine a
    // secret its own `stripe listen` will never mint: 400 invalid signature, with no obvious cause. Same
    // shape as the STRIPE_METER_EVENT_NAME bug — a value that merely LOOKS global.
    "each machine's `stripe listen` mints its own; a shared one guarantees 400 invalid signature",
  ],
]);

/** Parse a .dev.vars into name → value. Splits on the FIRST `=` (base64 padding, URLs with queries). */
export function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

/** Serialize name → value as dotenv. Values are written verbatim; sops encrypts each one. */
export function toEnv(values) {
  return [...values].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/**
 * Collect the shared credentials from the local .dev.vars files.
 *
 * A name set in two apps must AGREE — a silent disagreement would publish whichever app happened to be
 * read last, and the mismatch would then be baked into every machine that pulls.
 */
export function appScopedKey(app, name) {
  return `${app.toUpperCase()}__${name}`;
}

export function collectFromDevVars(readFile, names = sharedSecretNames(), appNames = APP_NAMES) {
  // First pass: every value each app holds for each name.
  const byName = new Map();
  for (const app of appNames) {
    const text = readFile(app);
    if (text === null) continue;
    const vars = parseEnv(text);
    for (const name of names) {
      const v = vars.get(name);
      if (v === undefined || v === "") continue;
      if (!byName.has(name)) byName.set(name, new Map());
      byName.get(name).set(app, v);
    }
  }

  // Second pass: one global entry where every app agrees, app-scoped entries where they do not.
  const values = new Map();
  const perApp = new Map();
  const split = [];
  for (const [name, holders] of byName) {
    const distinct = new Set(holders.values());
    if (distinct.size <= 1) {
      values.set(name, [...distinct][0]);
      continue;
    }
    split.push(name);
    for (const [app, v] of holders) perApp.set(appScopedKey(app, name), v);
  }
  return { values, perApp, split: split.sort(), conflicts: [] };
}

/**
 * What a pull may apply to ONE app: the intersection of the allowlist, that app's own declared vars,
 * and the values the vault actually carries.
 *
 * The allowlist has to be enforced here and not only on push, because the ciphertext is COMMITTED and so
 * outlives the allowlist that produced it. A vault written before a name was reclassified still carries
 * that name; trusting the file would re-apply it — reintroducing the STRIPE_METER_EVENT_NAME bug from a
 * file, long after the code was fixed. Blank-skipping mirrors `collectFromDevVars` for the same reason:
 * `!== undefined` counts "" as present, and merging that would blank a working credential.
 */
export function pullSet(values, specNames, shared = sharedSecretNames(), app = null) {
  const allow = new Set(shared);
  const out = new Map();
  for (const name of specNames) {
    // The allowlist is checked against the BARE name, so an app-scoped key cannot be used to smuggle an
    // unshareable name (RESEND_API_KEY, the Stripe whsec) back past NOT_SHAREABLE.
    if (!allow.has(name)) continue;
    // App-scoped wins. `webhook-auth login` and `webhook-play mint` are different Turnstile widgets with
    // different secrets, and both Workers read TURNSTILE_SECRET_KEY — so one value per NAME would hand
    // play auth's secret and fail every challenge with no useful error.
    const scoped = app === null ? undefined : values.get(appScopedKey(app, name));
    // If ANY app has a scoped entry for this name, the name is per-app and a bare global entry is STALE —
    // left by a vault pushed before the split. Falling back to it would hand this app another app's
    // secret, which is the precise failure the split exists to prevent. Discovered from the ciphertext
    // itself, so it needs no list of "names that differ": a correct push never leaves both forms.
    const isPerApp = [...values.keys()].some((k) => k.endsWith(`__${name}`));
    const v = scoped ?? (isPerApp ? undefined : values.get(name));
    if (v === undefined || v === "") continue;
    out.set(name, v);
  }
  return out;
}

/** Merge decrypted values into one .dev.vars body, replacing existing keys and appending new ones. */
export function mergeIntoDevVars(text, values) {
  let out = text;
  const appended = [];
  for (const [name, value] of values) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
    if (re.test(out)) out = out.replace(re, `${name}=${value}`);
    else appended.push(`${name}=${value}`);
  }
  if (appended.length > 0) out = out.replace(/\n*$/, "\n") + appended.join("\n") + "\n";
  return out;
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts });

function requireTools() {
  for (const tool of ["age", "sops"]) {
    if (spawnSync("which", [tool], { stdio: "ignore" }).status !== 0) {
      console.error(`\n✖ ${tool} is not installed. \`brew install age sops\`\n`);
      process.exit(1);
    }
  }
}

function devVarsPath(app) {
  return join(REPO, "apps", app, ".dev.vars");
}
/** Read an app's .dev.vars, or null when it has none. One syscall: a stat-then-read is a check-then-use
 *  window, and "missing" and "unreadable" are the same answer here anyway. */
function readDevVars(app) {
  try {
    return readFileSync(devVarsPath(app), "utf8");
  } catch {
    return null;
  }
}

function cmdInit(internal) {
  // A presence check that is NOT followed by a read in this process — sops/age open these paths
  // themselves — so there is no check-then-use window to close here.
  if (existsSync(WRAPPED_KEY(internal))) {
    console.error(
      `\n✖ ${WRAPPED_KEY(internal)} already exists.\n  Re-running --init would orphan every value already ` +
        `encrypted with the old key. Use --unlock on this machine instead.\n`,
    );
    process.exit(1);
  }
  mkdirSync(join(internal, "secrets"), { recursive: true });
  mkdirSync(dirname(LOCAL_KEY), { recursive: true });
  console.log("\n🔑 Generating an age keypair…");
  if (run("age-keygen", ["-o", LOCAL_KEY]).status !== 0) process.exit(1);
  const pub = /public key: (age1\w+)/.exec(readFileSync(LOCAL_KEY, "utf8"))?.[1];
  if (!pub) {
    console.error("✖ could not read the generated public key");
    process.exit(1);
  }
  writeFileSync(
    SOPS_CONFIG(internal),
    "# Recipients for the shared local-dev credentials. The PUBLIC key belongs here; the private key is\n" +
      "# wrapped with a passphrase in secrets/age-key.txt.age. See scripts/dev-secrets-vault.mjs.\n" +
      `creation_rules:\n  - path_regex: secrets/.*\\.env$\n    age: ${pub}\n`,
  );
  console.log(`   recipient written to ${SOPS_CONFIG(internal)}`);
  console.log("\n🔒 Now choose a passphrase to wrap the private key.");
  console.log("   Five or six random words. Nothing you have typed anywhere else.");
  console.log("   It is the ONLY thing protecting these credentials: the wrapped key is committed");
  console.log("   beside the ciphertext, so anyone who can read the repo can attack it offline.");
  console.log("   Keep it wherever you keep your other secrets — losing it orphans the vault.\n");
  if (run("age", ["-p", "-a", "-o", WRAPPED_KEY(internal), LOCAL_KEY]).status !== 0)
    process.exit(1);
  console.log(`\n✅ wrapped key written to ${WRAPPED_KEY(internal)}`);
  console.log("   Commit .sops.yaml and secrets/ in the internal repo, then run --push.\n");
}

function cmdUnlock(internal) {
  if (!existsSync(WRAPPED_KEY(internal))) {
    console.error(
      `\n✖ no wrapped key at ${WRAPPED_KEY(internal)} — run --init first (once, ever).\n`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(LOCAL_KEY), { recursive: true });
  console.log(`\n🔓 Unwrapping the age key onto this machine (${LOCAL_KEY})…\n`);
  if (run("age", ["-d", "-o", LOCAL_KEY, WRAPPED_KEY(internal)]).status !== 0) {
    console.error("\n✖ wrong passphrase, or the wrapped key is corrupt.\n");
    process.exit(1);
  }
  console.log("\n✅ unlocked — `pnpm dev:secrets --pull` will now work.\n");
}

function cmdPush(internal) {
  const { values, perApp, split } = collectFromDevVars(readDevVars);
  // A name whose values genuinely differ per app is stored app-scoped rather than refused. Said out loud
  // every time: a disagreement that is a MISTAKE looks identical to one that is legitimate, and the only
  // thing standing between the two is somebody reading this line.
  for (const name of split) {
    const apps = [...perApp.keys()]
      .filter((k) => k.endsWith(`__${name}`))
      .map((k) => k.slice(0, -`__${name}`.length).toLowerCase());
    console.log(
      `   per-app: ${name} differs across ${apps.join(", ")} — stored separately for each`,
    );
  }
  for (const [k, v] of perApp) values.set(k, v);
  if (values.size === 0) {
    console.error("\n✖ no shared credentials found in any .dev.vars — nothing to push.\n");
    process.exit(1);
  }
  // Say what is NOT travelling, and why. Silence here would read as "the vault has everything", and the
  // next person would spend the debugging time working out why their Stripe webhooks 400.
  for (const [name, why] of NOT_SHAREABLE) {
    console.log(`   not shared: ${name} — ${why}`);
  }
  mkdirSync(join(internal, "secrets"), { recursive: true });
  // Encrypt from STDIN — the plaintext never touches disk.
  //
  // The first version of this wrote the credentials to a temp file INSIDE the internal repo and deleted it
  // afterwards. That is the one thing this tool exists to prevent: a crash between write and delete, a
  // failed unlink, or a `git add` running concurrently would leave live production credentials sitting next
  // to the ciphertext meant to protect them. A temp file elsewhere would be better but still writes them
  // out; piping writes them nowhere.
  //
  // `--filename-override` is what makes it work: sops picks its creation rule from the FILE PATH, and
  // /dev/stdin matches nothing, so without the override it refuses with "no matching creation rules found".
  const res = spawnSync(
    "sops",
    [
      "--config",
      SOPS_CONFIG(internal),
      "-e",
      "--input-type",
      "dotenv",
      "--output-type",
      "dotenv",
      "--filename-override",
      "secrets/dev-secrets.enc.env",
      "/dev/stdin",
    ],
    { encoding: "utf8", env: sopsEnv(), input: toEnv(values) },
  );
  if (res.status !== 0) {
    console.error(`\n✖ sops failed to encrypt:\n${res.stderr}\n`);
    process.exit(1);
  }
  writeFileSync(CIPHERTEXT(internal), res.stdout);
  console.log(`\n✅ encrypted ${values.size} credentials into ${CIPHERTEXT(internal)}`);
  console.log(`   ${[...values.keys()].sort().join(", ")}`);
  console.log("   Commit it in the internal repo.\n");
}

function cmdPull(internal) {
  if (!existsSync(CIPHERTEXT(internal))) {
    console.error(
      `\n✖ nothing encrypted yet at ${CIPHERTEXT(internal)} — run --push on a machine that has them.\n`,
    );
    process.exit(1);
  }
  const res = spawnSync(
    "sops",
    [
      "--config",
      SOPS_CONFIG(internal),
      "-d",
      "--input-type",
      "dotenv",
      "--output-type",
      "dotenv",
      CIPHERTEXT(internal),
    ],
    { encoding: "utf8", env: sopsEnv() },
  );
  if (res.status !== 0) {
    console.error(
      `\n✖ could not decrypt. Run --unlock first if this machine has never had the key.\n${res.stderr}\n`,
    );
    process.exit(1);
  }
  const values = parseEnv(res.stdout);
  const shared = sharedSecretNames();
  const bare = (k) => (k.includes("__") ? k.slice(k.indexOf("__") + 2) : k);
  const ignored = [...values.keys()].filter((n) => !shared.includes(bare(n)));
  if (ignored.length > 0) {
    // Never silent: a name in the vault that the allowlist no longer shares is a stale entry someone
    // should clear with a fresh --push, and the pull is deliberately not honouring it.
    console.log(
      `   ignoring ${ignored.length} vault entries no longer shareable: ${ignored.join(", ")}`,
    );
  }
  let touched = 0;
  const applied = new Set();
  for (const app of APP_NAMES) {
    const wanted = pullSet(
      values,
      specsFor(app).map((s) => s.name),
      sharedSecretNames(),
      app,
    );
    if (wanted.size === 0) continue;
    const path = devVarsPath(app);
    // Read FIRST rather than stat-then-read: the stat is a check-then-use window, and a missing file
    // throws here just the same, which is the answer the check was asking for.
    let current;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      console.log(`   skipped ${app} — no .dev.vars yet (run \`pnpm dev:secrets\` first)`);
      continue;
    }
    writeFileSync(path, mergeIntoDevVars(current, wanted), { mode: 0o600 });
    for (const name of wanted.keys()) applied.add(name);
    console.log(`   ${app}: ${wanted.size} values`);
    touched++;
  }
  // Count what was APPLIED, not what the file held — otherwise an ignored entry still reads as delivered.
  console.log(`\n✅ pulled ${applied.size} credentials into ${touched} apps\n`);
}

function main() {
  const mode = process.argv[2];
  const internal = internalRepo();
  if (!existsSync(internal)) {
    console.error(
      `\n✖ the internal repo is not at ${internal}.\n  Clone it beside this one, or set WEBHOOK_INTERNAL_REPO.\n`,
    );
    process.exit(1);
  }
  requireTools();
  if (mode === "--init") return cmdInit(internal);
  if (mode === "--unlock") return cmdUnlock(internal);
  if (mode === "--push") return cmdPush(internal);
  if (mode === "--pull") return cmdPull(internal);
  console.error(
    "\nUsage: pnpm dev:secrets:vault --init | --unlock | --push | --pull\n\n" +
      "  --init    once ever: make the keypair, wrap it with your passphrase\n" +
      "  --unlock  once per machine: unwrap the key here\n" +
      "  --push    encrypt your local credentials into the internal repo\n" +
      "  --pull    decrypt them into every app's .dev.vars\n",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
