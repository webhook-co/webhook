#!/usr/bin/env node
/**
 * Guard: `apps/mcp/server.json` — the manifest published to the official MCP Registry
 * (registry.modelcontextprotocol.io) — stays publishable, truthful, and free of anything that
 * shouldn't be public.
 *
 * WHY THIS EXISTS. The manifest is the only artifact in this repo whose consumer is a THIRD PARTY
 * that we cannot re-run: `mcp-publisher publish` either accepts it or rejects it, and once accepted
 * it is what every MCP client, aggregator, and marketplace shows the world. The failure modes are
 * quiet ones:
 *
 *   - The registry caps `description` at 100 characters. The server's own in-code SERVER_DESCRIPTION
 *     was 109, so the obvious "just reuse it" would have been rejected at publish time with nothing
 *     in this repo to catch it. That is the defect this guard was written for.
 *   - Publishing is authorised by a DNS TXT record on the `webhook.co` apex, which grants exactly
 *     the `co.webhook/*` namespace. A name outside it is not a style question — it cannot be
 *     published at all, and the error the registry returns ("you do not have permission") does not
 *     say why.
 *   - The listing sends every client to `remotes[].url`. If that drifts from the URL our own docs
 *     tell people to use, the registry and the product disagree and neither side notices.
 *   - `https://webhook.co/*` 301s to `www.`. The registry's well-known fetcher disables redirects
 *     outright (internal/api/handlers/v0/auth/http.go), so an apex URL anywhere in the manifest is
 *     a trap rather than a preference.
 *
 * FLOOR. Every input is required: an unreadable manifest, an unparseable manifest, or docs that
 * document no remote URL are all FAILURES, never a pass over an empty set.
 *
 * Wired into the `lint` script, so it runs in the required `lint` CI job.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO, "apps", "mcp", "server.json");
const AGENT = join(REPO, "apps", "mcp", "src", "mcp-agent.ts");
const DOCS_DIR = join(REPO, "apps", "docs", "mcp");

/** Registry schema caps (definitions.ServerDetail in the published server.schema.json). */
export const REGISTRY_DESCRIPTION_MAX = 100;
export const REGISTRY_TITLE_MAX = 100;

/** `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` — the registry's own name pattern. */
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

/** DNS auth on the `webhook.co` apex grants this namespace and no other. */
const NAMESPACE = "co.webhook/";

const OFFICIAL_SCHEMA =
  /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/;

/** The one transport the server actually serves — `/sse` is a 404 in production. */
const TRANSPORT = "streamable-http";

/** Hosts that answer with a 301, so a client or the registry never reaches the content. */
const REDIRECTING_HOSTS = new Set(["webhook.co"]);

/**
 * Competitor names. Public-repo content hygiene permits these in `apps/www` marketing content
 * only, and a registry manifest is not that.
 */
const COMPETITORS = ["ngrok", "webhook.site", "svix", "hookdeck", "requestbin", "beeceptor"];

/** Shapes that are only ever real credentials — never a legitimate manifest value. */
const CREDENTIAL_PATTERNS = [
  /\bwhk_[A-Za-z0-9]{12,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  /\b[sp]k_(?:live|test)_[A-Za-z0-9]{8,}/,
];

const SEMVER_CORE = /^\d+\.\d+\.\d+$/;
const SEMVER_TAIL = /^[0-9A-Za-z.-]+$/;

/**
 * MAJOR.MINOR.PATCH with optional pre-release and build metadata.
 *
 * Split by hand rather than with one combined regex: `(?:-[\w.-]+)?(?:\+[\w.-]+)?$` has two
 * adjacent, overlapping character classes and backtracks exponentially on a crafted string
 * (eslint-plugin-security flags it). Each test below is anchored on a single class, so matching
 * is linear.
 */
export function isSemver(value) {
  const plus = value.indexOf("+");
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  const build = plus === -1 ? null : value.slice(plus + 1);

  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? null : withoutBuild.slice(dash + 1);

  if (!SEMVER_CORE.test(core)) return false;
  if (pre !== null && !SEMVER_TAIL.test(pre)) return false;
  if (build !== null && !SEMVER_TAIL.test(build)) return false;
  return true;
}

/** `https://mcp.webhook.co/...` occurrences — the URLs our docs actually send clients to. */
const REMOTE_URL_IN_DOCS = /https:\/\/mcp\.webhook\.co\/[A-Za-z0-9._~/-]*/g;

function readOr(path, fallback = null) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function realDocsSources() {
  let names;
  try {
    names = readdirSync(DOCS_DIR).filter((n) => n.endsWith(".mdx"));
  } catch {
    return [];
  }
  return names.map((n) => readOr(join(DOCS_DIR, n), "")).filter(Boolean);
}

/** Distinct remote URLs documented for humans. Empty means the docs-parity rule has no floor. */
export function documentedRemoteUrls(docsSources = realDocsSources()) {
  const found = new Set();
  for (const text of docsSources) {
    for (const [url] of text.matchAll(REMOTE_URL_IN_DOCS)) found.add(url);
  }
  return [...found].sort();
}

/** The version string the running server advertises to clients via `initialize`. */
export function advertisedVersion(agentSource) {
  return /SERVER_VERSION\s*=\s*"([^"]+)"/.exec(agentSource ?? "")?.[1] ?? null;
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/** Every string value anywhere in the manifest, for the content scans. */
function allStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out);
  else if (node && typeof node === "object")
    for (const v of Object.values(node)) allStrings(v, out);
  return out;
}

/** Every URL-ish string anywhere in the manifest. */
function allUrls(manifest) {
  return allStrings(manifest).filter((s) => s.startsWith("http://") || s.startsWith("https://"));
}

export function check(opts = {}) {
  const problems = [];

  const serverJsonSource = "serverJsonSource" in opts ? opts.serverJsonSource : readOr(MANIFEST);
  if (serverJsonSource === null || serverJsonSource === undefined) {
    problems.push(
      `mcp-registry-guard: cannot read apps/mcp/server.json. The registry manifest is required — ` +
        `without it nothing can be published and this guard has nothing to check.`,
    );
    return problems;
  }

  let manifest;
  try {
    manifest = JSON.parse(serverJsonSource);
  } catch (err) {
    problems.push(
      `apps/mcp/server.json does not parse as JSON: ${err instanceof Error ? err.message : err}`,
    );
    return problems;
  }

  const agentSource = "agentSource" in opts ? opts.agentSource : readOr(AGENT, "");
  const documented = documentedRemoteUrls(
    "docsSources" in opts ? (opts.docsSources ?? []) : realDocsSources(),
  );

  // --- identity -----------------------------------------------------------
  if (!OFFICIAL_SCHEMA.test(manifest.$schema ?? "")) {
    problems.push(
      `$schema must be an official registry schema URL ` +
        `(https://static.modelcontextprotocol.io/schemas/<date>/server.schema.json), got ` +
        `${JSON.stringify(manifest.$schema)}.`,
    );
  }

  const name = manifest.name ?? "";
  if (!NAME_PATTERN.test(name)) {
    problems.push(
      `name ${JSON.stringify(name)} breaks the registry's name pattern ${NAME_PATTERN}.`,
    );
  } else if (!name.startsWith(NAMESPACE)) {
    problems.push(
      `name ${JSON.stringify(name)} is outside the "${NAMESPACE}" namespace. Publishing is ` +
        `authorised by the DNS TXT record on the webhook.co apex, which grants that namespace and ` +
        `no other — any other prefix is rejected with a permission error that does not say why.`,
    );
  }

  // --- the caps that reject a publish -------------------------------------
  const description = manifest.description ?? "";
  if (description.length === 0 || description.length > REGISTRY_DESCRIPTION_MAX) {
    problems.push(
      `description is ${description.length} characters; the registry requires 1..` +
        `${REGISTRY_DESCRIPTION_MAX}. (The server's in-code SERVER_DESCRIPTION is longer than ` +
        `this cap — it cannot simply be reused here.)`,
    );
  }
  if ("title" in manifest) {
    const title = manifest.title ?? "";
    if (title.length === 0 || title.length > REGISTRY_TITLE_MAX) {
      problems.push(
        `title is ${title.length} characters; the registry requires 1..${REGISTRY_TITLE_MAX}.`,
      );
    }
  }

  // --- version: the listing must not disagree with the running server ------
  const version = manifest.version ?? "";
  if (!isSemver(version)) {
    problems.push(`version ${JSON.stringify(version)} is not semver (MAJOR.MINOR.PATCH).`);
  }
  const advertised = advertisedVersion(agentSource);
  if (advertised === null) {
    problems.push(
      `cannot find SERVER_VERSION in apps/mcp/src/mcp-agent.ts, so the manifest version cannot be ` +
        `checked against what the server actually advertises.`,
    );
  } else if (advertised !== version) {
    problems.push(
      `version ${JSON.stringify(version)} disagrees with the SERVER_VERSION the running server ` +
        `advertises via initialize (${JSON.stringify(advertised)}). A client would see one version ` +
        `in the registry and another on connect.`,
    );
  }

  // --- remotes ------------------------------------------------------------
  const remotes = Array.isArray(manifest.remotes) ? manifest.remotes : [];
  if (remotes.length === 0) {
    problems.push(`remotes is empty — this is a remote server, so it must advertise its endpoint.`);
  }
  if (documented.length === 0) {
    problems.push(
      `apps/docs/mcp documents no remote URL, so the manifest's endpoint cannot be checked ` +
        `against what we tell users to connect to.`,
    );
  }
  for (const remote of remotes) {
    if (remote?.type !== TRANSPORT) {
      problems.push(
        `remote type ${JSON.stringify(remote?.type)} is not ${TRANSPORT}; the server serves only ` +
          `streamable-HTTP (/sse is a 404 in production).`,
      );
    }
    if (documented.length > 0 && !documented.includes(remote?.url)) {
      problems.push(
        `remote url ${JSON.stringify(remote?.url)} is not documented in apps/docs/mcp ` +
          `(documented: ${documented.join(", ")}). The registry would send every client somewhere ` +
          `our own docs never mention.`,
      );
    }
    for (const header of remote?.headers ?? []) {
      if (header?.isSecret || /^authorization$/i.test(header?.name ?? "")) {
        problems.push(
          `remote declares a secret header ${JSON.stringify(header?.name)}. The server authenticates ` +
            `with OAuth (RFC 9728 discovery is live); advertising a paste-your-token header teaches ` +
            `every listing the weaker flow.`,
        );
      }
    }
  }

  // --- reachability -------------------------------------------------------
  for (const url of allUrls(manifest)) {
    if (url.startsWith("http://")) {
      problems.push(`${url} is not https.`);
    }
    const host = hostOf(url);
    if (host !== null && REDIRECTING_HOSTS.has(host)) {
      problems.push(
        `${url} is on ${host}, which 301-redirects (to www.). The registry's well-known fetcher ` +
          `disables redirects, so use the host that answers 200 directly.`,
      );
    }
  }

  // --- content hygiene ----------------------------------------------------
  const haystack = allStrings(manifest).join("\n");
  const lowered = haystack.toLowerCase();
  for (const competitor of COMPETITORS) {
    if (lowered.includes(competitor)) {
      problems.push(
        `manifest mentions the competitor ${JSON.stringify(competitor)}. Competitor names are ` +
          `permitted in apps/www marketing content only.`,
      );
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    const hit = pattern.exec(haystack);
    if (hit !== null) {
      problems.push(
        `manifest contains what looks like a credential (${pattern}). Nothing in this file is ` +
          `private — it is published verbatim to a public registry.`,
      );
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length > 0) {
    console.error("mcp-registry-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  console.log(
    `mcp-registry-guard: OK (${manifest.name} v${manifest.version} → ` +
      `${manifest.remotes.map((r) => r.url).join(", ")})`,
  );
}
