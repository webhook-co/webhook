import { buildCommand } from "@stricli/core";

import { ENV_API_URL_VAR, probeReachability, resolveApiBaseUrl } from "../api-client.js";
import {
  ConfigNotFoundError,
  CorruptConfigError,
  InsecureConfigPermissionsError,
} from "../config/errors.js";
import { ENV_API_KEY_VAR } from "../config/env-store.js";
import { configFilePath, loadConfigFile } from "../config/file-store.js";
import { resolveCacheDir, resolveConfigDir, resolveStateDir } from "../config/paths.js";
import type { AppContext } from "../context.js";
import {
  globalFlags,
  resolveActiveProfile,
  resolveGlobals,
  type GlobalFlags,
} from "../global-flags.js";
import { colorize, type Color } from "../output/color.js";
import { EXIT } from "../output/exit-codes.js";
import { renderJson } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";
import { VERSION } from "../version.js";

// `wbhk doctor` — local, silent diagnostics: the cli version, terminal/color state, the active
// credential + its source, the config file's health (perms/parse), API reachability + clock skew, and the
// on-disk paths. Each check is a small pure function over already-gathered facts (so it's unit-tested in
// isolation); the command handler does the impure gathering (fs + one network probe) and renders.
//
// Exit codes: FAIL (exit 1) is reserved for a must-fix LOCAL misconfiguration (a corrupt or
// world-readable config) — something the user has to act on. Everything transient or external is a WARN
// that keeps exit 0: not-logged-in, clock skew, and an unreachable API (offline / captive wifi / a typo'd
// --api-url is not a broken install). So `doctor` stays a friendly status, not a connectivity gate. No
// telemetry: nothing leaves the box but the single unauthenticated reachability probe.

/** A skew beyond this warns — minted keys are time-bound, so a wrong clock breaks auth (matters for D8). */
const CLOCK_SKEW_THRESHOLD_MS = 60_000;

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export function versionCheck(versionLabel: string): Check {
  return { name: "cli", status: "ok", detail: `wbhk ${versionLabel}` };
}

export function terminalCheck(opts: { colorEnabled: boolean; isInteractive: boolean }): Check {
  const color = opts.colorEnabled ? "color on" : "color off";
  const tty = opts.isInteractive ? "stdin interactive (tty)" : "stdin not a tty";
  return { name: "terminal", status: "ok", detail: `${color}, ${tty}` };
}

export function credentialCheck(opts: {
  loggedIn: boolean;
  /** The real backend the credential came from: "env" | "keychain" | "file" (or null when logged out). */
  source: string | null;
  profile: string;
}): Check {
  const profile = sanitizeControl(opts.profile);
  if (opts.loggedIn) {
    return {
      name: "credential",
      status: "ok",
      detail: `logged in to profile \`${profile}\` (via ${opts.source})`,
    };
  }
  return {
    name: "credential",
    status: "warn",
    detail: `not logged in (profile \`${profile}\`) — run \`wbhk login\``,
  };
}

export function apiReachabilityCheck(opts: {
  reachable: boolean;
  status?: number;
  baseUrl: string;
}): Check {
  if (opts.reachable) {
    return {
      name: "api",
      status: "ok",
      detail: `reachable at ${opts.baseUrl} (HTTP ${opts.status ?? "?"})`,
    };
  }
  // A WARN, not a FAIL — unreachable is usually transient (offline) or a typo'd --api-url, not a broken
  // install, so `doctor` shouldn't exit non-zero just because the network is down.
  return {
    name: "api",
    status: "warn",
    detail: `unreachable at ${opts.baseUrl} (offline or wrong URL?)`,
  };
}

export function clockCheck(opts: { serverDate?: Date; now: number; thresholdMs: number }): Check {
  if (opts.serverDate === undefined) {
    return {
      name: "clock",
      status: "warn",
      detail: "could not read server time (api unreachable or no Date header)",
    };
  }
  const skewMs = Math.abs(opts.serverDate.getTime() - opts.now);
  const skewSec = Math.round(skewMs / 1000);
  if (skewMs > opts.thresholdMs) {
    const limit = Math.round(opts.thresholdMs / 1000);
    return {
      name: "clock",
      status: "warn",
      detail: `clock skew ${skewSec}s (> ${limit}s) — may affect token validity`,
    };
  }
  return { name: "clock", status: "ok", detail: `in sync (±${skewSec}s)` };
}

export type ConfigProbe = { readonly kind: "ok" | "absent" | "insecure" | "corrupt" };
export function configCheckFrom(probe: ConfigProbe): Check {
  switch (probe.kind) {
    case "ok":
      return { name: "config", status: "ok", detail: "valid" };
    case "absent":
      return { name: "config", status: "ok", detail: "no config yet (run `wbhk login`)" };
    case "insecure":
      return { name: "config", status: "fail", detail: "file permissions too open — must be 0600" };
    case "corrupt":
      return { name: "config", status: "fail", detail: "unreadable or invalid — fix or remove it" };
  }
}

export function pathsCheck(opts: { configDir: string; stateDir: string; cacheDir: string }): Check {
  return {
    name: "paths",
    status: "ok",
    detail: `config ${opts.configDir} · state ${opts.stateDir} · cache ${opts.cacheDir}`,
  };
}

export function summarizeChecks(checks: readonly Check[]): { ok: boolean } {
  return { ok: checks.every((c) => c.status !== "fail") };
}

const SYMBOL: Record<CheckStatus, { glyph: string; color: Color }> = {
  ok: { glyph: "✓", color: "green" },
  warn: { glyph: "⚠", color: "yellow" },
  fail: { glyph: "✗", color: "red" },
};

function renderDoctorText(checks: readonly Check[], color: boolean): string {
  return checks
    .map((c) => {
      const s = SYMBOL[c.status];
      return `${colorize(s.glyph, s.color, color)} ${c.name}: ${c.detail}`;
    })
    .join("\n");
}

export const doctorCommand = buildCommand<GlobalFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const { format, color } = resolveGlobals(this, flags);
    const env = this.process.env ?? {};
    const { name: profile } = await resolveActiveProfile(this, flags);

    // The placeholder version means an unstamped local build → mark it `(dev)` (Open-Q3).
    const versionLabel = VERSION === "0.0.0" ? `${VERSION} (dev)` : VERSION;

    // credential + the REAL backend it resolves from (env › keychain › file). getWithSource reports the
    // actual backend so a keychain credential reads as "keychain", not a mislabeled "file"; an inline test
    // fake without it falls back to the env-or-file heuristic.
    const resolved = this.store.getWithSource ? await this.store.getWithSource(profile) : null;
    const cred = resolved?.cred ?? (await this.store.get(profile));
    const envKey = env[ENV_API_KEY_VAR];
    const source: string | null =
      cred === null
        ? null
        : (resolved?.source ?? (envKey !== undefined && envKey !== "" ? "env" : "file"));

    // config file health (existence / perms / parse), via the same trusted reader the store uses.
    const configDir = resolveConfigDir(env, this.homedir);
    let configProbe: ConfigProbe;
    try {
      await loadConfigFile(configFilePath(configDir), { platform: this.platform });
      configProbe = { kind: "ok" };
    } catch (err) {
      if (err instanceof ConfigNotFoundError) configProbe = { kind: "absent" };
      else if (err instanceof InsecureConfigPermissionsError) configProbe = { kind: "insecure" };
      else if (err instanceof CorruptConfigError) configProbe = { kind: "corrupt" };
      else throw err;
    }

    // one bounded, unauthenticated probe → reachability + the server clock.
    const baseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: env[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(profile),
    });
    const probe = await probeReachability({ fetch: this.io.fetch, baseUrl });

    const checks: Check[] = [
      versionCheck(versionLabel),
      terminalCheck({ colorEnabled: this.colorEnabled, isInteractive: this.io.isInteractive }),
      credentialCheck({ loggedIn: cred !== null, source, profile }),
      configCheckFrom(configProbe),
      apiReachabilityCheck({ reachable: probe.reachable, status: probe.status, baseUrl }),
      clockCheck({
        serverDate: probe.serverDate,
        now: Date.now(),
        thresholdMs: CLOCK_SKEW_THRESHOLD_MS,
      }),
      pathsCheck({
        configDir,
        stateDir: resolveStateDir(env, this.homedir),
        cacheDir: resolveCacheDir(env, this.homedir),
      }),
    ];
    const summary = summarizeChecks(checks);

    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ checks, ok: summary.ok })}\n`
        : `${renderDoctorText(checks, color)}\n`,
    );
    // A failed check is a real problem (corrupt/insecure config, api unreachable) → non-zero for CI.
    if (!summary.ok) this.process.exitCode = EXIT.UNEXPECTED;
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "run local diagnostics (auth, config, connectivity, clock)" },
});
