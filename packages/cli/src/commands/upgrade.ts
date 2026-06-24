import { createHash } from "node:crypto";
import { basename } from "node:path";

import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { CliError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { EXIT } from "../output/exit-codes.js";
import { renderJson } from "../output/format.js";
import { VERSION } from "../version.js";

// `wbhk upgrade` — self-update a standalone binary install (the `curl | sh` / direct-download route), or
// point a package-managed install (npm / Homebrew / Scoop) at its own updater. The logic is pure +
// unit-tested here; the command handler does the impure work (fetch the latest release, download + verify,
// atomically replace the running binary via an injected io seam). Mirrors install.sh's fail-closed checksum
// gate, but in TS so it's testable.

/** How this `wbhk` was installed — determines whether we self-replace or defer to a package manager. */
export type InstallKind = "binary" | "npm" | "homebrew" | "scoop";

/** The shape of a GitHub Release we care about (the `/releases` API, trimmed to the used fields). */
export interface ReleaseSummary {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{ readonly name: string; readonly browser_download_url: string }>;
}

/** The published release-asset name for this OS/arch, or null when no prebuilt binary ships for it. Mirrors
 *  release-build.mjs's TARGETS (x64 ships as the `-baseline` build under the plain `wbhk-<os>-x64` name). */
export function assetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "wbhk-darwin-arm64";
    if (arch === "x64") return "wbhk-darwin-x64";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "wbhk-linux-x64";
    if (arch === "arm64") return "wbhk-linux-arm64";
    return null;
  }
  if (platform === "win32") {
    // Only an x64 build ships; Windows-on-arm64 runs it under emulation.
    if (arch === "x64" || arch === "arm64") return "wbhk-windows-x64.exe";
    return null;
  }
  return null;
}

const RUNTIME_BASENAMES = new Set(["node", "node.exe", "bun", "bun.exe"]);

/** Classify the install from the running executable's path. A node/bun runtime → the npm (or dev) install;
 *  a binary under a Homebrew Cellar / a Scoop apps dir → that manager; otherwise a standalone binary we can
 *  self-replace. (Heuristic but safe: the self-replace path is additionally gated by write-permission +
 *  the checksum, so a mis-classified managed install just fails the write rather than corrupting anything.) */
export function detectInstallKind(execPath: string): InstallKind {
  // Normalize Windows backslashes so this works cross-platform (the test host is POSIX, and a packed
  // binary may report a Windows path); basename() over forward slashes then holds on every OS.
  const norm = execPath.replace(/\\/g, "/");
  if (RUNTIME_BASENAMES.has(basename(norm).toLowerCase())) return "npm";
  const p = norm.toLowerCase();
  if (p.includes("/cellar/")) return "homebrew";
  if (p.includes("/scoop/")) return "scoop";
  return "binary";
}

function coreTriplet(version: string): [number, number, number] {
  const core = version.replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `latest`'s core x.y.z is strictly greater than `current`'s (prerelease/build metadata ignored
 *  — adequate for the release line; a dev build "0.0.0" upgrades to any real release). */
export function isUpgradeAvailable(current: string, latest: string): boolean {
  const [a, b, c] = coreTriplet(current);
  const [x, y, z] = coreTriplet(latest);
  if (x !== a) return x > a;
  if (y !== b) return y > b;
  return z > c;
}

const CLI_TAG_RE = /^cli-v(\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?)$/;

/** `cli-vX.Y.Z` → `X.Y.Z`. Throws on any tag that isn't a CLI release tag. */
export function tagToVersion(tag: string): string {
  const m = CLI_TAG_RE.exec(tag);
  if (m === null) throw new Error(`not a wbhk CLI release tag: ${tag}`);
  return m[1] as string;
}

/** The newest published (non-draft, non-prerelease) `cli-v*` release from the `/releases` list (the API
 *  returns it newest-first), or null when none exists. Scans rather than trusting `/releases/latest`, which
 *  is repo-wide and could be a non-CLI release in this monorepo. */
export function selectLatestCliRelease(releases: readonly ReleaseSummary[]): ReleaseSummary | null {
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    if (CLI_TAG_RE.test(r.tag_name)) return r;
  }
  return null;
}

/** The download URL for a named asset in a release; throws if the release doesn't carry it. */
export function findAssetUrl(release: ReleaseSummary, name: string): string {
  const asset = release.assets.find((a) => a.name === name);
  if (asset === undefined) {
    throw new Error(`release ${release.tag_name} has no asset named ${name}`);
  }
  return asset.browser_download_url;
}

/** Verify the downloaded bytes against checksums.txt — FAILS CLOSED. Requires the asset's line to EXIST
 *  before comparing (a checksums.txt that omits the asset must abort, never "verify" nothing — the same
 *  guarantee install.sh makes), then requires the sha256 to match. */
export function verifyChecksum(data: Uint8Array, checksumsText: string, name: string): void {
  // Parse `<hex>  [*]<name>` (sha256sum format; `*` = binary mode) and EXACT-match the filename field — not
  // a suffix match, so `wbhk-linux-x64` can't be satisfied by a line for some other `…-wbhk-linux-x64`.
  const entry = checksumsText
    .split("\n")
    .map((l) => /^([0-9a-fA-F]+)\s+\*?(.+?)\s*$/.exec(l.trim()))
    .find((m) => m !== null && m[2] === name);
  if (entry === null || entry === undefined) {
    throw new Error(`no checksum entry for ${name} — refusing to upgrade`);
  }
  const expected = (entry[1] ?? "").toLowerCase();
  const actual = createHash("sha256").update(data).digest("hex");
  if (expected.length === 0 || actual !== expected) {
    throw new Error(`checksum verification failed for ${name} — refusing to upgrade`);
  }
}

/** The "use your package manager" message for a managed install. */
export function managedUpgradeHint(kind: Exclude<InstallKind, "binary">): string {
  switch (kind) {
    case "npm":
      return "this wbhk was installed via npm — upgrade with `npm install -g wbhk@latest` (or `npx wbhk@latest`).";
    case "homebrew":
      return "this wbhk was installed via Homebrew — upgrade with `brew upgrade wbhk`.";
    case "scoop":
      return "this wbhk was installed via Scoop — upgrade with `scoop update wbhk`.";
  }
}

/** What `wbhk upgrade` should do, decided purely from the gathered facts (so it's unit-tested without the
 *  build-stamped VERSION or any I/O). The handler executes the plan: only `install` touches the binary. */
export type UpgradePlan =
  | { readonly action: "no-release" }
  | { readonly action: "up-to-date"; readonly current: string; readonly latest: string }
  | { readonly action: "available"; readonly current: string; readonly latest: string }
  | {
      readonly action: "managed";
      readonly kind: Exclude<InstallKind, "binary">;
      readonly current: string;
      readonly latest: string;
    }
  | {
      readonly action: "unsupported";
      readonly current: string;
      readonly latest: string;
      readonly platform: NodeJS.Platform;
      readonly arch: string;
    }
  | {
      readonly action: "install";
      readonly current: string;
      readonly latest: string;
      readonly assetName: string;
    };

export function planUpgrade(opts: {
  current: string;
  release: ReleaseSummary | null;
  installKind: InstallKind;
  platform: NodeJS.Platform;
  arch: string;
  checkOnly: boolean;
}): UpgradePlan {
  if (opts.release === null) return { action: "no-release" };
  const latest = tagToVersion(opts.release.tag_name);
  const current = opts.current;
  if (!isUpgradeAvailable(current, latest)) return { action: "up-to-date", current, latest };
  // An update exists. `--check` only reports it (precedes the install-kind branch — never touches disk).
  if (opts.checkOnly) return { action: "available", current, latest };
  if (opts.installKind !== "binary") {
    return { action: "managed", kind: opts.installKind, current, latest };
  }
  const name = assetName(opts.platform, opts.arch);
  if (name === null) {
    return { action: "unsupported", current, latest, platform: opts.platform, arch: opts.arch };
  }
  return { action: "install", current, latest, assetName: name };
}

// ── command handler (impure: GitHub fetch + binary self-replace, both via injected io seams) ──

const RELEASES_API = "https://api.github.com/repos/webhook-co/webhook/releases?per_page=30";
const RELEASES_PAGE = "https://github.com/webhook-co/webhook/releases";
const USER_AGENT = "wbhk-cli"; // GitHub's REST API requires a User-Agent.

/** A recoverable `wbhk upgrade` failure (network / missing asset / checksum / replace) → a clean, on-voice
 *  message + exit 1, never a stack trace. */
export class UpgradeError extends CliError {
  readonly exitCode = EXIT.UNEXPECTED;
  readonly userMessage: string;
  constructor(message: string) {
    super(message);
    this.name = "UpgradeError";
    this.userMessage = message;
  }
}

async function fetchReleases(fetchFn: typeof fetch): Promise<ReleaseSummary[]> {
  let res: Response;
  try {
    res = await fetchFn(RELEASES_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    });
  } catch (err) {
    throw new UpgradeError(
      `could not reach GitHub to check for updates — ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
  if (!res.ok)
    throw new UpgradeError(`could not check for updates — GitHub returned ${res.status}.`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as ReleaseSummary[]) : [];
}

async function downloadBytes(fetchFn: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new UpgradeError(`download failed — server returned ${res.status}.`);
  return new Uint8Array(await res.arrayBuffer());
}

async function downloadText(fetchFn: typeof fetch, url: string): Promise<string> {
  const res = await fetchFn(url);
  if (!res.ok) throw new UpgradeError(`download failed — server returned ${res.status}.`);
  return res.text();
}

/** Resolve the asset + checksums URLs, download both, and verify the sha256 — fail-closed — returning the
 *  verified bytes. Any failure (missing asset, network, bad/absent checksum) surfaces as a clean
 *  UpgradeError, so every install-path error shares the same on-voice shape + exit code. */
async function fetchVerifiedAsset(
  fetchFn: typeof fetch,
  release: ReleaseSummary,
  name: string,
): Promise<Uint8Array> {
  try {
    const data = await downloadBytes(fetchFn, findAssetUrl(release, name));
    const checksums = await downloadText(fetchFn, findAssetUrl(release, "checksums.txt"));
    verifyChecksum(data, checksums, name);
    return data;
  } catch (err) {
    if (err instanceof UpgradeError) throw err;
    throw new UpgradeError(err instanceof Error ? err.message : String(err));
  }
}

interface UpgradeFlags extends GlobalFlags {
  check?: boolean;
}

export const upgradeCommand = buildCommand<UpgradeFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const { format } = resolveGlobals(this, flags);
    const current = VERSION;
    const release = selectLatestCliRelease(await fetchReleases(this.io.fetch));
    const plan = planUpgrade({
      current,
      release,
      installKind: detectInstallKind(this.execPath),
      platform: this.platform,
      arch: this.arch,
      checkOnly: flags.check === true,
    });

    const emit = (result: object, textLines: readonly string[]): void => {
      this.process.stdout.write(
        format === "json" ? `${renderJson(result)}\n` : `${textLines.join("\n")}\n`,
      );
    };

    switch (plan.action) {
      case "no-release":
        emit({ action: plan.action, currentVersion: current, updateAvailable: false }, [
          "no published wbhk release yet — check back soon.",
        ]);
        return;
      case "up-to-date":
        emit(
          {
            action: plan.action,
            currentVersion: current,
            latestVersion: plan.latest,
            updateAvailable: false,
          },
          [`wbhk is up to date (${current}).`],
        );
        return;
      case "available":
        emit(
          {
            action: plan.action,
            currentVersion: current,
            latestVersion: plan.latest,
            updateAvailable: true,
          },
          [`update available: ${current} → ${plan.latest}. run \`wbhk upgrade\` to install.`],
        );
        return;
      case "managed":
        emit(
          {
            action: plan.action,
            currentVersion: current,
            latestVersion: plan.latest,
            updateAvailable: true,
            installKind: plan.kind,
          },
          [`update available: ${current} → ${plan.latest}.`, managedUpgradeHint(plan.kind)],
        );
        return;
      case "unsupported":
        emit(
          {
            action: plan.action,
            currentVersion: current,
            latestVersion: plan.latest,
            updateAvailable: true,
            platform: plan.platform,
            arch: plan.arch,
          },
          [
            `update available: ${current} → ${plan.latest}, but no prebuilt binary ships for ` +
              `${plan.platform}/${plan.arch} — download manually from ${RELEASES_PAGE}.`,
          ],
        );
        return;
      case "install": {
        // plan.action === "install" implies release !== null (planUpgrade); narrow it for TS.
        if (release === null) return;
        if (format !== "json") {
          this.process.stderr.write(`downloading wbhk ${plan.latest} (${plan.assetName})…\n`);
        }
        // Resolve + download + verify, surfacing any failure (missing asset / network / bad checksum) as a
        // clean UpgradeError — fail-closed BEFORE we touch the binary.
        const data = await fetchVerifiedAsset(this.io.fetch, release, plan.assetName);
        try {
          await this.io.replaceExecutable(this.execPath, data);
        } catch (err) {
          throw new UpgradeError(
            `could not replace the binary at ${this.execPath} — ` +
              `${err instanceof Error ? err.message : String(err)}. you may need write access to that ` +
              `directory (use a writable install dir, or your package manager).`,
          );
        }
        emit(
          {
            action: plan.action,
            currentVersion: current,
            latestVersion: plan.latest,
            updateAvailable: true,
            installKind: "binary",
          },
          [`upgraded wbhk ${current} → ${plan.latest}.`],
        );
        return;
      }
    }
  },
  parameters: {
    flags: {
      ...globalFlags,
      check: {
        kind: "boolean",
        optional: true,
        brief: "only check whether an update is available (don't install)",
      },
    },
  },
  docs: { brief: "update wbhk to the latest release" },
});
