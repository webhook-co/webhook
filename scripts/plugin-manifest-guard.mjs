#!/usr/bin/env node
/**
 * The agent-plugin manifest is publishable, executable configuration. This pins it to the rules the
 * directory actually enforces.
 *
 * WHY THIS EXISTS. Three of these rules cannot be caught by reading the docs or by imitating shipped
 * plugins, which is exactly why they belong in a gate:
 *
 *   1. `displayName` and `shortDescription` are capped at 80/240 for PACKAGE validation and at
 *      **30** for FINAL DIRECTORY SUBMISSION. 163 of the 180 curated plugins in `openai/plugins`
 *      exceed 30, so copying the corpus produces a package that validates clean locally and is then
 *      rejected on length alone.
 *   2. The MCP config must point at `./.mcp.json` and that file must name exactly our one remote server,
 *      with `oauth_resource` equal to the `resource` our PRM declares. A drifted `oauth_resource` makes
 *      every client request a token for the wrong RFC 8707 audience, which our own resource server then
 *      rejects — presenting as "auth is broken" rather than as a one-line config typo.
 *
 *      This guard previously asserted the OPPOSITE — that `mcpServers` must be ABSENT, because a
 *      skills-only submission was said to be rejected for carrying one (`mcp_configuration_excluded`).
 *      That was FALSE. 8 of the 180 curated plugins (github, linear, notion, figma, cloudflare and
 *      OpenAI's own openai-developers) ship skills AND `mcpServers`; the spec's own sample manifest
 *      carries skills, hooks, mcpServers and apps together; and the string appears nowhere in the
 *      shipped validator. See ADR-0132, which supersedes ADR-0131.
 *   3. `name` is IMMUTABLE across updates (`plugin_name_mismatch`) and namespaces every skill, so a
 *      rename is a new listing, not an edit.
 *
 * FLOOR. Every input is required: an unreadable manifest, an unparseable manifest, and a plugin with
 * no skills are all FAILURES, never a pass over an empty set. Skills are DISCOVERED by walking
 * `skills/`, not read from a list here — a curated list would report on the list.
 *
 * WHAT IT DOES NOT PROVE. It does not run the plugin, does not check that the skill's prose is true,
 * and does not talk to OpenAI. It is a shape-and-limits guard. The authorities are OpenAI's own
 * `validate_plugin.py` and `plugin-eval`, which are run by hand at authoring time; this is the part
 * that has to hold on every commit.
 *
 * Wired into the `lint` script, so it runs in the required `lint` CI job.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
export const PLUGIN_DIR = join(REPO, "plugin", "webhook-co");
const MANIFEST = join(PLUGIN_DIR, ".codex-plugin", "plugin.json");
const SKILLS_DIR = join(PLUGIN_DIR, "skills");
/** The one path `mcpServers` may point at, so the file this guard validates is the file that ships. */
const MCP_CONFIG_REF = "./.mcp.json";
const MCP_CONFIG = join(PLUGIN_DIR, ".mcp.json");

/** OpenAI's closed category enum. */
const CATEGORIES = new Set([
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
]);

/** Error-level in OpenAI's own `plugin-eval`, regardless of what the prose docs call optional. */
const REQUIRED_INTERFACE = [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "websiteURL",
  "privacyPolicyURL",
  "termsOfServiceURL",
  "defaultPrompt",
];

/** Caps that bind at FINAL SUBMISSION, which are stricter than package validation. */
const MAX = { displayName: 30, shortDescription: 30, defaultPromptEntry: 128, defaultPrompts: 3 };
const MAX_COMBINED_ID = 64;

/**
 * Strict semver, hand-split into single-character classes. The combined
 * `(?:-[\w.-]+)?(?:\+[\w.-]+)?$` form backtracks exponentially and `eslint-plugin-security` flags it.
 */
const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER_TAIL = /^[0-9A-Za-z.-]+$/;
export function isSemver(value) {
  if (typeof value !== "string") return false;
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

/**
 * Lowercase hyphen-case, checked segment by segment rather than with `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
 * That form nests a quantifier inside a quantifier, which is the classic catastrophic-backtracking
 * shape `eslint-plugin-security` flags — the same reason `isSemver` above is hand-split. Splitting on
 * the separator is linear and says what it means.
 */
const SEGMENT = /^[a-z0-9]+$/;
export function isHyphenCase(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const segments = value.split("-");
  return segments.every((segment) => SEGMENT.test(segment));
}

function readOr(path, fallback = null) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Minimal frontmatter read — `name` and `description` are the only keys Codex's loader consumes. */
function parseFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---/.exec(source ?? "");
  if (match === null) return { name: "", description: "" };
  // Fixed patterns, not a constructed RegExp: only two keys are ever read, and building a pattern
  // from a variable is both a lint warning and a habit worth not forming in a guard.
  const NAME = /^name:[ \t]*(.*)$/m;
  const DESCRIPTION = /^description:[ \t]*(.*)$/m;
  const field = (re) => {
    const m = re.exec(match[1]);
    return m === null ? "" : m[1].trim();
  };
  return { name: field(NAME), description: field(DESCRIPTION) };
}

/**
 * Walk `skills/` for real skill directories. Discovery, not a list: a skill added tomorrow is checked
 * without anyone remembering to register it here.
 */
export function discoverSkills(dir = SKILLS_DIR) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const source = readOr(join(dir, entry.name, "SKILL.md"));
    if (source === null) continue;
    const { name, description } = parseFrontmatter(source);
    found.push({ dir: entry.name, name, description });
  }
  return found;
}

/** The interface asset paths that must resolve on disk. */
function declaredAssets(iface) {
  return [iface.composerIcon, iface.logo, iface.logoDark].filter(
    (p) => typeof p === "string" && p.length > 0,
  );
}

/**
 * The `.mcp.json` contract. These four values are the ones that break the listing SILENTLY if they drift:
 * a wrong url leaves clients unable to connect, and a wrong `oauth_resource` makes them request a token for
 * the wrong RFC 8707 audience — which our resource server then rejects, presenting as "auth is broken"
 * rather than as a config typo.
 */
const MCP_URL = "https://mcp.webhook.co/mcp";
/** MUST equal the `resource` our live PRM declares (apps/mcp: MCP_RESOURCE), not the /mcp path. */
const MCP_OAUTH_RESOURCE = "https://mcp.webhook.co";

function checkMcpConfig(opts) {
  const problems = [];
  const source = "mcpSource" in opts ? opts.mcpSource : readOr(MCP_CONFIG);
  if (source === null || source === undefined) {
    problems.push(
      `cannot read ${MCP_CONFIG}, but plugin.json points \`mcpServers\` at it. An MCP-backed plugin ` +
        `whose config is missing installs as a plugin that connects to nothing.`,
    );
    return problems;
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch (err) {
    problems.push(`.mcp.json does not parse: ${err instanceof Error ? err.message : err}`);
    return problems;
  }

  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null) {
    problems.push(".mcp.json is missing a `mcpServers` object.");
    return problems;
  }
  const names = Object.keys(servers);
  if (names.length !== 1) {
    problems.push(
      `.mcp.json declares ${names.length} servers (${names.join(", ") || "none"}); the listing is ONE ` +
        `server. Extras would be installed on users' machines without appearing in the listing.`,
    );
    return problems;
  }

  const server = servers[names[0]];
  if (server?.command !== undefined || server?.args !== undefined) {
    problems.push(
      `.mcp.json server "${names[0]}" declares \`command\`/\`args\`, i.e. a local stdio process. This is ` +
        `a REMOTE server: a published plugin must not spawn a local process on an installer's machine.`,
    );
    return problems;
  }
  if (server?.type !== "http") {
    problems.push(
      `.mcp.json server "${names[0]}" must be \`type: "http"\` (streamable-http). Our /sse endpoint is a ` +
        `404 — there is no SSE transport to fall back to.`,
    );
  }
  if (server?.url !== MCP_URL) {
    problems.push(
      `.mcp.json url is ${JSON.stringify(server?.url)}; it must be exactly "${MCP_URL}" (https, and the ` +
        `/mcp path — /sse 404s).`,
    );
  }
  if (server?.oauth_resource !== MCP_OAUTH_RESOURCE) {
    problems.push(
      `.mcp.json oauth_resource is ${JSON.stringify(server?.oauth_resource)}; it must be exactly ` +
        `"${MCP_OAUTH_RESOURCE}" — the \`resource\` our PRM declares. RFC 8707 binds the token to that ` +
        `audience, so a mismatch makes every client's token be rejected as the wrong audience.`,
    );
  }
  return problems;
}

export function check(opts = {}) {
  const problems = [];

  const manifestSource = "manifestSource" in opts ? opts.manifestSource : readOr(MANIFEST);
  if (manifestSource === null || manifestSource === undefined) {
    problems.push(
      `plugin-manifest-guard: cannot read ${MANIFEST}. The manifest is required — without it there ` +
        `is no plugin to publish and this guard has nothing to check.`,
    );
    return problems;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch (err) {
    problems.push(
      `plugin.json does not parse as JSON: ${err instanceof Error ? err.message : err}`,
    );
    return problems;
  }

  const dirName = "dirName" in opts ? opts.dirName : basename(PLUGIN_DIR);

  // Validate the tree the MANIFEST points at, not a hardcoded one. `skills` is the only field
  // connecting the manifest to the thing being shipped; repoint it or drop it and a guard that walks
  // `skills/` regardless would keep printing OK while the published plugin loads a tree it never
  // opened. Pinned to the one supported value: the directory path is fixed by the platform
  // ("`skills` must resolve to the root `skills/` directory"), so anything else is a defect, not a
  // configuration.
  if (manifest.skills !== "./skills/") {
    problems.push(
      `plugin.json \`skills\` is ${JSON.stringify(manifest.skills)}; it must be "./skills/". The path ` +
        `is fixed by the platform, and this guard validates that directory — a different value would ` +
        `ship a skill tree nothing checked.`,
    );
  }
  const skills = "skills" in opts ? opts.skills : discoverSkills();
  const assetPaths =
    "assetPaths" in opts
      ? opts.assetPaths
      : declaredAssets(manifest.interface ?? {}).filter((p) => existsSync(join(PLUGIN_DIR, p)));

  // ---- identity
  if (typeof manifest.name !== "string" || !isHyphenCase(manifest.name)) {
    problems.push(
      `name "${manifest.name}" must be lowercase hyphen-case (letters, digits, single hyphens).`,
    );
  } else if (manifest.name !== dirName) {
    problems.push(
      `name "${manifest.name}" does not match its directory "${dirName}". The directory name and the ` +
        `manifest name must be identical — the name is the component namespace and is immutable across updates.`,
    );
  }
  if (typeof manifest.name === "string" && manifest.name.length > MAX_COMBINED_ID) {
    problems.push(`name is ${manifest.name.length} characters; the cap is ${MAX_COMBINED_ID}.`);
  }
  if (!isSemver(manifest.version)) {
    problems.push(`version "${manifest.version}" is not strict semver.`);
  }
  for (const field of ["description", "author", "license", "repository", "keywords"]) {
    if (manifest[field] === undefined) problems.push(`plugin.json is missing \`${field}\`.`);
  }
  if (manifest.author !== undefined && typeof manifest.author?.name !== "string") {
    problems.push("`author.name` is required (`plugin_developer_missing`).");
  }

  // ---- MCP-backed invariants (ADR-0132)
  //
  // `apps` stays excluded: it points at a ChatGPT Apps SDK manifest for custom iframe UI, which we do not
  // ship. `hooks` stays excluded because the shipped validator rejects the key and 0 of 180 curated plugins
  // use it. `mcpServers` is now REQUIRED — see the header note on the false exclusivity claim.
  for (const excluded of ["apps", "hooks"]) {
    if (manifest[excluded] !== undefined) {
      problems.push(
        `plugin.json declares \`${excluded}\`, which this plugin does not ship: \`apps\` is for ChatGPT ` +
          `Apps SDK custom UI, and \`hooks\` is rejected by the shipped validator (0 of 180 curated ` +
          `plugins declare it).`,
      );
    }
  }
  if (manifest.mcpServers !== MCP_CONFIG_REF) {
    problems.push(
      `plugin.json must declare \`mcpServers: "${MCP_CONFIG_REF}"\` (found ` +
        `${JSON.stringify(manifest.mcpServers)}). This is an MCP-backed submission, and the guard ` +
        `validates the contents of that exact file — repointing the field would leave the real config ` +
        `unchecked while this guard still printed OK.`,
    );
  } else {
    problems.push(...checkMcpConfig(opts));
  }

  const iface = manifest.interface;
  if (typeof iface !== "object" || iface === null) {
    problems.push("plugin.json is missing the required `interface` object.");
    return problems;
  }
  if (Array.isArray(iface.screenshots) && iface.screenshots.length > 0) {
    problems.push(
      "`interface.screenshots` is non-empty. Screenshots require an MCP-backed submission with custom UI; " +
        "screenshots describe custom Apps-SDK UI, which we do not ship — we expose tools, not widgets.",
    );
  }

  // ---- required interface fields
  //
  // PRESENT AND NON-EMPTY. Checking only for `undefined` would let `displayName: ""` or
  // `capabilities: []` through — present, therefore "supplied", and rejected at submission for being
  // blank. An empty required field is a missing one wearing a different shape.
  for (const field of REQUIRED_INTERFACE) {
    const value = iface[field];
    if (value === undefined || value === null) {
      problems.push(`plugin.json interface is missing \`${field}\`.`);
    } else if (typeof value === "string" && value.trim().length === 0) {
      problems.push(`plugin.json interface \`${field}\` is empty.`);
    } else if (Array.isArray(value) && value.length === 0) {
      problems.push(`plugin.json interface \`${field}\` is an empty array.`);
    }
  }
  if (iface.category !== undefined && !CATEGORIES.has(iface.category)) {
    problems.push(`interface.category "${iface.category}" is not one of OpenAI's categories.`);
  }

  // ---- the length traps
  for (const field of ["displayName", "shortDescription"]) {
    const value = iface[field];
    if (typeof value === "string" && value.length > MAX[field]) {
      problems.push(
        `interface.${field} is ${value.length} characters. Package validation allows more, but FINAL ` +
          `DIRECTORY SUBMISSION caps it at ${MAX[field]} — a package that validates clean is still ` +
          `rejected on length.`,
      );
    }
  }
  if (iface.defaultPrompt !== undefined && !Array.isArray(iface.defaultPrompt)) {
    // A bare string is accepted by neither the schema nor the caps below — gating the length checks
    // on `Array.isArray` alone made both of them dead for that shape, and `agents/openai.yaml` uses a
    // bare `default_prompt` string, so the confusion is one copy-paste away.
    problems.push("interface.defaultPrompt must be an array of strings.");
  }
  if (Array.isArray(iface.defaultPrompt)) {
    if (iface.defaultPrompt.length > MAX.defaultPrompts) {
      problems.push(
        `interface.defaultPrompt has ${iface.defaultPrompt.length} entries; the cap is ${MAX.defaultPrompts}.`,
      );
    }
    for (const prompt of iface.defaultPrompt) {
      if (typeof prompt === "string" && prompt.length > MAX.defaultPromptEntry) {
        problems.push(
          `an interface.defaultPrompt entry is ${prompt.length} characters; the final-submission cap is ${MAX.defaultPromptEntry}.`,
        );
      }
    }
  }

  // ---- assets resolve
  for (const declared of declaredAssets(iface)) {
    // "present in the plugin directory" has to mean inside it. `join()` resolves `..`, so without
    // this an asset could point at a file outside the published tree and still read as present.
    if (declared.includes("..")) {
      problems.push(`interface asset "${declared}" escapes the plugin directory.`);
      continue;
    }
    if (!assetPaths.includes(declared)) {
      problems.push(
        `interface asset "${declared}" is declared but not present in the plugin directory.`,
      );
    }
  }

  // ---- skills
  if (!Array.isArray(skills) || skills.length === 0) {
    problems.push(
      "the plugin declares no skills. We ship skills AND a remote MCP server deliberately: the skill is " +
        "the part that works with NO account and no OAuth, so losing it would quietly turn this into an " +
        "auth-gated-only listing whose install-to-value time is a signup flow.",
    );
  } else {
    for (const skill of skills) {
      if (skill.name !== skill.dir) {
        problems.push(
          `skill "${skill.dir}" declares name "${skill.name}"; the SKILL.md name must match its directory.`,
        );
      }
      if (typeof skill.description !== "string" || skill.description.trim().length === 0) {
        problems.push(
          `skill "${skill.dir}" has no frontmatter description — it is the auto-load surface.`,
        );
      }
      if (typeof skill.description === "string" && skill.description.length > 1024) {
        problems.push(
          `skill "${skill.dir}" description is ${skill.description.length} characters; the cap is 1024.`,
        );
      }
      const combined = `${manifest.name}:${skill.name}`;
      if (combined.length > MAX_COMBINED_ID) {
        problems.push(
          `"${combined}" is ${combined.length} characters; plugin-name:skill-name must be ${MAX_COMBINED_ID} or fewer.`,
        );
      }
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length > 0) {
    console.error("plugin-manifest-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const skills = discoverSkills();
  console.log(
    `plugin-manifest-guard: OK (${manifest.name} v${manifest.version}, skills + remote MCP, ` +
      `${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((s) => s.name).join(", ")})`,
  );
}
