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
 *   2. A skills-only submission is REJECTED if it carries `mcpServers`, `apps`, or a non-empty
 *      `interface.screenshots` (`mcp_configuration_excluded`, `app_configuration_excluded`,
 *      `screenshot_configuration_excluded`). Adding an MCP reference is the single most natural
 *      "improvement" someone would make to this plugin, and it silently changes the submission class.
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

  // ---- skills-only invariants
  for (const excluded of ["mcpServers", "apps", "hooks"]) {
    if (manifest[excluded] !== undefined) {
      problems.push(
        `plugin.json declares \`${excluded}\`. This is a SKILLS-ONLY plugin: a skills-only submission ` +
          `is rejected when it carries mcpServers/apps, and \`hooks\` is rejected by the shipped ` +
          `validator. Adding one changes the submission class and re-activates every MCP gate ` +
          `(domain verification, reviewer demo credentials, tool annotations).`,
      );
    }
  }

  const iface = manifest.interface;
  if (typeof iface !== "object" || iface === null) {
    problems.push("plugin.json is missing the required `interface` object.");
    return problems;
  }
  if (Array.isArray(iface.screenshots) && iface.screenshots.length > 0) {
    problems.push(
      "`interface.screenshots` is non-empty. Screenshots require an MCP-backed submission with custom UI; " +
        "a skills-only upload carrying them is rejected.",
    );
  }

  // ---- required interface fields
  for (const field of REQUIRED_INTERFACE) {
    if (iface[field] === undefined) problems.push(`plugin.json interface is missing \`${field}\`.`);
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
    if (!assetPaths.includes(declared)) {
      problems.push(
        `interface asset "${declared}" is declared but not present in the plugin directory.`,
      );
    }
  }

  // ---- skills
  if (!Array.isArray(skills) || skills.length === 0) {
    problems.push(
      "the plugin declares no skills. A skills-only plugin whose runtime surface is empty is rejected " +
        "(`plugin_runtime_surface_missing`) — an app or MCP reference would not satisfy it either.",
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
    `plugin-manifest-guard: OK (${manifest.name} v${manifest.version}, skills-only, ` +
      `${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((s) => s.name).join(", ")})`,
  );
}
