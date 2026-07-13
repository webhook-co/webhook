#!/usr/bin/env node
// PACKAGED-ARTIFACT SMOKE TEST for the TypeScript SDK.
//
// The unit suite imports from `src/`. That proves the CODE works; it proves NOTHING about the thing users
// actually install. A broken `exports` map, a file missing from `files:`, a bad `types` path, or a dangling
// import in the build output all ship green — the tests never touch the tarball.
//
// So: `npm pack` the real package, install THAT tarball into a scratch dir, import it the way a user would,
// and drive it against a live stub server. If the published artifact is unusable, this fails.
//
// Run: node scripts/sdk-packaged-smoke.mjs

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const SDK_DIR = resolve(import.meta.dirname, "..", "packages", "sdk-ts");
const scratch = mkdtempSync(join(tmpdir(), "sdk-smoke-"));
let failures = 0;

const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${extra}`}`);
  if (!cond) failures++;
};

/** A stub that mirrors the SERVER's real cursor semantics (see packages/db/src/agent-triggers.ts): a page
 *  with events returns a fresh cursor; an EMPTY page echoes the cursor you sent; null only when none sent. */
function startStub() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      const u = new URL(req.url, "http://x");
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === "/v1/endpoints" && req.method === "POST") {
        return send({
          id: "11111111-1111-4111-8111-111111111111",
          orgId: "22222222-2222-4222-8222-222222222222",
          name: "orders",
          paused: false,
          createdAt: "2026-07-13T00:00:00Z",
          dedupConfig: null,
          ingestUrl: "https://wbhk.my/whep_SEALED",
        });
      }
      if (u.pathname.endsWith("/reveal-ingest-url"))
        return send({ ingestUrl: "https://wbhk.my/whep_SEALED" });
      if (u.pathname === "/v1/usage") {
        return send({
          periodStart: "2026-07-01T00:00:00Z",
          periodEnd: null,
          capKind: "lifetime",
          events: 42,
          eventCap: 5000,
          pausePolicy: "pause",
          paused: false,
        });
      }
      if (u.pathname.endsWith("/wait")) {
        const cursor = u.searchParams.get("cursor");
        if (cursor === null)
          return send({ events: [{ id: "ev1" }], nextCursor: "c1", caughtUp: false });
        return send({ events: [], nextCursor: cursor, caughtUp: true });
      }
      send({});
    });
  });
  return new Promise((r) =>
    server.listen(0, () =>
      r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }),
    ),
  );
}

try {
  console.log("packing the real tarball (npm pack) …");
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", scratch], {
    cwd: SDK_DIR,
    encoding: "utf8",
  }).trim();

  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({
      name: "smoke",
      private: true,
      type: "module",
      dependencies: { "@webhook-co/sdk": `file:${tarball}` },
    }),
  );
  console.log("installing the tarball into a scratch dir …");
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: "inherit",
  });

  // Import it exactly as a user would: a BARE SPECIFIER resolved through the package's own exports map.
  // Reaching into node_modules/.../dist/index.js instead would bypass the exports map — which is precisely
  // the thing that breaks (a wrong "exports" entry throws ERR_PACKAGE_PATH_NOT_EXPORTED for real users while
  // every test stays green).
  const { WebhookClient } = await import(
    /* @vite-ignore */ pathToFileURL(join(scratch, "node_modules", "@webhook-co", "sdk")).href
  ).catch(async () => {
    // Resolve the bare specifier from INSIDE the scratch package, the way a consumer's Node would.
    const req = createRequire(join(scratch, "package.json"));
    const entry = req.resolve("@webhook-co/sdk");
    return import(pathToFileURL(entry).href);
  });
  check(
    "the packaged artifact imports via its EXPORTS MAP and exposes WebhookClient",
    typeof WebhookClient === "function",
  );

  const stub = await startStub();
  const client = new WebhookClient({ apiKey: "whk_smoke_test_key_abcdefgh", baseUrl: stub.url });

  const ep = await client.endpoints.create({ name: "orders" });
  check(
    "endpoints.create returns the ingest url",
    ep.ingestUrl === "https://wbhk.my/whep_SEALED",
    ep.ingestUrl,
  );

  const revealed = await client.endpoints.revealIngestUrl(ep.id);
  check(
    "endpoints.revealIngestUrl recovers the SAME url (no rotation)",
    revealed.ingestUrl === ep.ingestUrl,
  );

  const usage = await client.usage.get();
  check("usage.get works", usage.events === 42, JSON.stringify(usage));

  // The ack-by-cursor loop, driven for real.
  let cursor = null;
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const page = await client.triggers.wait("11111111-1111-4111-8111-111111111111", { cursor });
    seen.push(...page.events);
    cursor = page.nextCursor;
  }
  check("triggers.wait drains events and terminates", seen.length === 1, JSON.stringify(seen));
  const waits = stub.calls.filter((c) => c.url.includes("/wait"));
  check(
    "triggers.wait never sends a literal cursor=null",
    !waits.some((c) => c.url.includes("cursor=null")),
  );

  await client.triggers.wait("11111111-1111-4111-8111-111111111111", { includeBody: false });
  const last = stub.calls.at(-1);
  check(
    "includeBody=false serialises lowercase (the API ignores anything else)",
    last.url.includes("includeBody=false"),
    last.url,
  );

  const reveal = stub.calls.find((c) => c.url.includes("reveal-ingest-url"));
  check(
    "reveal is a POST carrying the bearer",
    reveal.method === "POST" && reveal.auth === "Bearer whk_smoke_test_key_abcdefgh",
  );

  stub.close();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  failures === 0 ? "\npackaged TS SDK: ALL PASS" : `\npackaged TS SDK: ${failures} FAILURE(S)`,
);
process.exit(failures ? 1 : 0);
