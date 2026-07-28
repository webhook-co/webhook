#!/usr/bin/env node
// PACKAGED-ARTIFACT SMOKE TEST for @webhook-co/webhooks-spec.
//
// The unit suite imports from `src/`. That proves the CODE works; it proves NOTHING about the thing
// users actually install. This package was private for its whole life, so nothing ever loaded its
// build output — and the build output did not load. `tsc` emitted the source's extensionless
// relative specifiers verbatim (`from "./scheme"`), which TypeScript resolves and Node's ESM loader
// does not. `npm i @webhook-co/webhooks-spec` would have thrown ERR_MODULE_NOT_FOUND on the first
// import, with a green test suite behind it.
//
// So: pack the real package, install THAT tarball into a scratch dir, import it the way a user
// would — both `import` and `require` — and make it verify a real signature. If the published
// artifact is unusable, this fails.
//
// Run: node scripts/webhooks-spec-packaged-smoke.mjs

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PKG_DIR = resolve(import.meta.dirname, "..", "packages", "webhooks-spec");
const scratch = mkdtempSync(join(tmpdir(), "webhooks-spec-smoke-"));
let failures = 0;

const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${extra}`}`);
  if (!cond) failures++;
};

try {
  // ── 1. Pack the real package, the way it is actually published ──────────────
  // PNPM, not npm, and the distinction is load-bearing. This package keeps `main`/`types`/`exports`
  // pointing at `src/` so the five workspace packages that consume it keep resolving TypeScript
  // source; the rewrite to `dist/` lives in `publishConfig`. Replacing those fields at pack time is a
  // PNPM feature — `npm pack`/`npm publish` ignore it entirely and would upload a tarball whose entry
  // point is `src/index.ts`, i.e. TypeScript, to a registry. Step 2 below asserts the rewrite
  // happened, so if the publish path is ever switched to plain npm this fails instead of shipping.
  console.log("packing…");
  execFileSync("pnpm", ["pack", "--pack-destination", scratch], {
    cwd: PKG_DIR,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarball = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");
  console.log(`  packed ${tarball}`);

  // ── 2. The packed manifest must point at the BUILD, not at the source ───────
  const packed = JSON.parse(
    execFileSync("tar", ["-xzOf", join(scratch, tarball), "package/package.json"], {
      encoding: "utf8",
    }),
  );
  check("packed `main` points at dist", String(packed.main).includes("dist"), packed.main);
  check("packed `types` points at dist", String(packed.types).includes("dist"), packed.types);
  check(
    "packed `exports` ships no TypeScript source",
    !JSON.stringify(packed.exports ?? {}).includes("src/"),
    JSON.stringify(packed.exports),
  );

  // ── 2b. The legal files `files` promises must actually be IN the tarball ────
  // `packages/webhooks-spec/LICENSE` does not exist on disk, yet `files` lists it and the manifest
  // declares Apache-2.0. It ships anyway because `pnpm pack` hoists the workspace-root LICENSE — and
  // `files` is a wish list, not a manifest: npm drops entries with no file behind them silently, with
  // exit 0, so asserting the manifest field would prove nothing. Only the packed bytes can.
  //
  // Scope, stated honestly: this runs `pnpm pack`, so it can only prove the tarball WE publish carries
  // a real licence. It cannot detect a switch to plain `npm publish` — npm does not hoist, and this
  // check would never run on that path. Step 2's `main`/`exports` assertions are what catch that
  // switch; this one catches the licence going missing, being emptied, or being replaced with
  // something that is not Apache-2.0.
  const packedFiles = execFileSync("tar", ["-tzf", join(scratch, tarball)], { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const legal of ["LICENSE", "NOTICE"]) {
    const present = packedFiles.includes(`package/${legal}`);
    check(`tarball ships ${legal}`, present, `packed files: ${packedFiles.join(", ")}`);
    if (!present) continue;
    const body = execFileSync("tar", ["-xzOf", join(scratch, tarball), `package/${legal}`], {
      encoding: "utf8",
    });
    check(`${legal} is non-empty`, body.trim().length > 0, `${body.length} bytes`);
    if (legal === "LICENSE") {
      check(
        "LICENSE text matches the declared Apache-2.0",
        body.includes("Apache License") && body.includes("Version 2.0"),
        `declared "${packed.license}", first line: ${body.split("\n")[0]}`,
      );
    }
  }

  // ── 3. Install it as a user would ───────────────────────────────────────────
  const app = join(scratch, "app");
  execFileSync("mkdir", ["-p", app]);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "smoke", private: true, version: "1.0.0", type: "module" }),
  );
  console.log("installing the tarball…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(scratch, tarball)], {
    cwd: app,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const entry = join(app, "node_modules", "@webhook-co", "webhooks-spec");

  // ── 4. ESM import, the way a user writes it ─────────────────────────────────
  const esm = await import(pathToFileURL(join(entry, "dist", "index.js")).href);
  check("ESM entry loads", typeof esm === "object" && esm !== null);
  check("exports detectScheme", typeof esm.detectScheme === "function");
  check("exports getAdapterForScheme", typeof esm.getAdapterForScheme === "function");

  // A FLOOR, not an exact count: the registry is meant to grow, and a test that pins 141 would fail
  // on the next contribution. But a tree-shaken or half-bundled artifact would collapse this to a
  // handful, which is the failure this is actually watching for.
  check(
    `registry is populated (${esm.PROVIDERS?.length} providers)`,
    Array.isArray(esm.PROVIDERS) && esm.PROVIDERS.length >= 100,
    `got ${esm.PROVIDERS?.length}`,
  );
  check(
    "every provider has an adapter",
    esm.ADAPTER_SCHEMES.length === esm.PROVIDERS.length,
    `${esm.ADAPTER_SCHEMES?.length} adapters vs ${esm.PROVIDERS?.length} providers`,
  );

  // ── 5. Make it actually verify something ────────────────────────────────────
  // The whole point of the package. GitHub: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the
  // raw body, no signed timestamp — so the vector is reproducible here without mocking a clock.
  const secret = "It's a Secret to Everybody";
  const rawBody = new TextEncoder().encode('{"zen":"Non-blocking is better than blocking."}');
  const mac = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");

  const headers = [["x-hub-signature-256", `sha256=${mac}`]];
  check("detectScheme identifies GitHub from its header", esm.detectScheme(headers) === "github");

  const adapter = esm.getAdapterForScheme("github");
  // The result is a discriminated union on `ok`, not a boolean and not a status string. Asserting the
  // WRONG shape here would have made all three of these checks vacuous — `undefined !== "verified"` is
  // true for every possible result, so the two negative cases would have passed against an adapter
  // that always succeeds. Assert on `ok` explicitly, and assert the failure reason exists.
  const good = await adapter.verify({ rawBody, headers, secrets: [secret] });
  check("a VALID GitHub signature verifies", good.ok === true, JSON.stringify(good));
  check("...and names the key that matched", good.ok === true && typeof good.keyId === "string");

  const bad = await adapter.verify({ rawBody, headers, secrets: ["the-wrong-secret"] });
  check("a WRONG secret does NOT verify", bad.ok === false, JSON.stringify(bad));
  check(
    "...and says why",
    bad.ok === false && typeof bad.reason?.code === "string",
    JSON.stringify(bad),
  );

  const tampered = await adapter.verify({
    rawBody: new TextEncoder().encode('{"zen":"tampered"}'),
    headers,
    secrets: [secret],
  });
  check("a TAMPERED body does NOT verify", tampered.ok === false, JSON.stringify(tampered));

  // ── 6. CJS require, for the half of the ecosystem that still does ───────────
  const cjsProbe = join(app, "probe.cjs");
  writeFileSync(
    cjsProbe,
    `const m = require("@webhook-co/webhooks-spec");
     if (typeof m.detectScheme !== "function") { console.error("no detectScheme"); process.exit(1); }
     if (!Array.isArray(m.PROVIDERS) || m.PROVIDERS.length < 100) { console.error("registry empty"); process.exit(1); }
     console.log("cjs-ok");`,
  );
  let cjsOut = "";
  try {
    cjsOut = execFileSync("node", [cjsProbe], { cwd: app, encoding: "utf8" }).trim();
  } catch (err) {
    cjsOut = `threw: ${err.message}`;
  }
  check("CJS require works", cjsOut === "cjs-ok", cjsOut);

  // ── 7. The declarations a TypeScript user resolves ──────────────────────────
  const dts = readdirSync(join(entry, "dist"));
  check("ships index.d.ts", dts.includes("index.d.ts"));
  check("ships index.d.cts", dts.includes("index.d.cts"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✔ packaged artifact is usable" : `\n✖ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
