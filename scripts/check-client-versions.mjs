#!/usr/bin/env node
// CLIENT_LATEST is a DERIVED fact: the truth lives in npm, PyPI and the Go module proxy. It is committed in
// packages/shared/src/client-advisory.ts because the API needs it at request time — and a committed copy of
// a fact that lives elsewhere ROTS. That is not hypothetical: the Python SDK's generated models fell 12
// schemas behind the spec while CI stayed green, purely because nothing tied the guard to the source.
//
// So: ask the registries what they actually serve, and fail if the committed table disagrees.
//
// A stale CLIENT_LATEST is not cosmetic — it means we tell a user on the newest SDK that they are current
// when they are not, or (worse) we never advise anyone at all. The advisory silently becomes a no-op.
//
// Run: node scripts/check-client-versions.mjs

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = resolve(import.meta.dirname, "..", "packages", "shared", "src", "client-advisory.ts");

/** Pull the committed table out of the source (avoids importing TS from a plain node script). */
function committedLatest() {
  const src = readFileSync(SRC, "utf8");
  const block = /export const CLIENT_LATEST[^{]*\{([^}]*)\}/.exec(src);
  if (!block) throw new Error("could not find CLIENT_LATEST in client-advisory.ts");
  const out = {};
  for (const [, id, version] of block[1].matchAll(/"([\w-]+)":\s*"([^"]+)"/g)) out[id] = version;
  return out;
}

// ── Retry the TRANSPORT, never the ANSWER ───────────────────────────────────────────────────────────────
//
// This guard reads three live registries, so without a retry it measures network luck as well as registry
// contents. On 2026-07-29 it reded a PR with `TypeError: fetch failed` / `read ECONNRESET` while the
// versions were in fact correct — the same "teaches everyone to ignore a red check" failure the comments
// below already work to avoid, arriving over the network instead of through a lagging field.
//
// The distinction that keeps this honest: a 5xx/429 or a dropped connection is the registry FAILING TO
// ANSWER, and asking again is legitimate. A 404 is the registry ANSWERING — retrying it would turn a fast,
// true failure (package renamed, deleted, typo'd) into a slow one that fails anyway. So 4xx is never
// retried. This adds robustness without softening a single real finding.

/** How many times to ask before giving up. */
const ATTEMPTS = 3;

/**
 * Is this outcome worth another attempt?
 *
 * Pure and exported so that broadening it — say, to include 404 — is a visible test failure rather than a
 * quiet loss of signal.
 *
 * @param {{status?: number, error?: unknown}} outcome
 */
export function isRetryable({ status, error }) {
  if (error !== undefined) return true; // fetch rejected: DNS, TLS, ECONNRESET — never a real answer
  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * `fetch`, retried on transport failures with a short linear backoff.
 *
 * `fetchImpl`/`sleep` are injectable purely so the retry behaviour is testable without real network or real
 * waiting — a retry nobody has watched recover is a retry nobody knows works.
 */
export async function fetchRetrying(
  url,
  init,
  { fetchImpl = fetch, attempts = ATTEMPTS, sleep } = {},
) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (error) {
      last = error;
      if (attempt === attempts) break;
      await wait(attempt * 500);
      continue;
    }
    // A real answer, good or bad, is returned as-is: the caller's own !res.ok check reports it.
    if (!isRetryable({ status: res.status }) || attempt === attempts) return res;
    last = new Error(`HTTP ${res.status}`);
    await wait(attempt * 500);
  }
  throw new Error(`${url}: giving up after ${attempts} attempts — ${last}`, { cause: last });
}

async function npmLatest(pkg) {
  const res = await fetchRetrying(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) throw new Error(`npm ${pkg}: HTTP ${res.status}`);
  return (await res.json()).version;
}

/**
 * Pick the newest version from PyPI's `releases` map.
 *
 * NOT `info.version`: that field LAGS — it still said 0.2.1 for about a minute after 0.3.0 was published,
 * while /pypi/webhook-co/0.3.0/json resolved fine. Reading it would fail this guard spuriously right after
 * every release, the same trap as the Go module proxy's cached @latest (which is why that one asks GitHub).
 *
 * Sorting is NUMERIC per part, not lexicographic: "0.10.0" < "0.9.0" as strings, but 10 > 9.
 * Exported for tests — an untested "pick the latest" is how you end up advising the wrong version.
 */
export function pickLatest(versions) {
  const parsed = versions
    .map((v) => ({ v, parts: /^(\d+)\.(\d+)\.(\d+)$/.exec(v) }))
    .filter((x) => x.parts !== null) // ignore prereleases/dev builds — only stable releases are "latest"
    .map((x) => ({ v: x.v, n: [Number(x.parts[1]), Number(x.parts[2]), Number(x.parts[3])] }));
  if (parsed.length === 0) {
    throw new Error("no stable releases found — refusing to guess a latest version");
  }
  parsed.sort((a, b) => a.n[0] - b.n[0] || a.n[1] - b.n[1] || a.n[2] - b.n[2]);
  return parsed[parsed.length - 1].v;
}

async function pypiLatest(pkg) {
  const res = await fetchRetrying(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
  if (!res.ok) throw new Error(`pypi ${pkg}: HTTP ${res.status}`);
  return pickLatest(Object.keys((await res.json()).releases ?? {}));
}

/**
 * The Go SDK's latest, from GitHub — NOT from the module proxy.
 *
 * The proxy's `@latest` is CACHED and lags: minutes after tagging v0.3.0 it still reported v0.2.0, even
 * though `@v/v0.3.0.info` resolved fine. Using it here would fail this guard spuriously after every Go
 * release and teach everyone to ignore a red check. GitHub's release list is authoritative and immediate.
 */
async function goLatest() {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchRetrying(
    "https://api.github.com/repos/webhook-co/webhook-go/releases/latest",
    {
      headers,
    },
  );
  if (!res.ok) throw new Error(`github webhook-go releases: HTTP ${res.status}`);
  return (await res.json()).tag_name.replace(/^v/, "");
}

const SOURCES = {
  "webhook-co-js": () => npmLatest("@webhook-co/sdk"),
  "webhook-co-python": () => pypiLatest("webhook-co"),
  "webhook-co-go": () => goLatest(),
  "wbhk-cli": () => npmLatest("@webhook-co/cli"),
};

/**
 * Only run when INVOKED DIRECTLY. Importing this module (the tests do, for `pickLatest`) must not fire off
 * live registry requests or call process.exit — a module with side effects on import is untestable, which
 * is exactly why this helper went unguarded in the first place.
 */
async function run() {
  const committed = committedLatest();
  let stale = 0;

  for (const [id, fetchLatest] of Object.entries(SOURCES)) {
    const published = await fetchLatest();
    const declared = committed[id];
    if (declared === published) {
      console.log(`  ok    ${id}: ${declared}`);
      continue;
    }
    stale++;
    console.log(`  STALE ${id}: CLIENT_LATEST says ${declared}, the registry serves ${published}`);
  }

  // A client we ship but never check would sit unguarded — the same "looks covered, isn't" trap as an
  // unmapped model or an unexempted route.
  for (const id of Object.keys(committed)) {
    if (!(id in SOURCES)) {
      stale++;
      console.log(`  STALE ${id}: declared in CLIENT_LATEST but this script never checks it`);
    }
  }

  if (stale > 0) {
    console.error(
      `\n${stale} client version(s) out of date in packages/shared/src/client-advisory.ts.\n` +
        "Bump CLIENT_LATEST to match the registries. If you just published, this is the reminder.",
    );
    process.exit(1);
  }
  console.log("\nCLIENT_LATEST matches every registry.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
