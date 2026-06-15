import { homedir as osHomedir } from "node:os";

import type { ApplicationContext } from "@stricli/core";

import { createEnvBackend } from "./config/env-store.js";
import { createFileBackend } from "./config/file-store.js";
import { resolveConfigDir } from "./config/paths.js";
import { resolveStore, type CredentialStore } from "./config/store.js";

/** Env var that forces a hard fail rather than persisting a plaintext credential. */
export const REQUIRE_SECURE_STORAGE_VAR = "WBHK_REQUIRE_SECURE_STORAGE";

// The minimal host surface the CLI needs — Node's `process` satisfies it, and tests pass a
// fake. All system access flows through here (stricli's "isolated context" model), so
// command handlers never touch a global and are deterministically testable.
export interface HostProcess {
  readonly stdout: {
    write(s: string): void;
    getColorDepth?(env?: Record<string, string | undefined>): number;
  };
  readonly stderr: { write(s: string): void };
  readonly env: Record<string, string | undefined>;
  readonly platform: NodeJS.Platform;
  exitCode?: number | string | null;
}

// The CLI's command context: stricli's ApplicationContext (process streams + exitCode)
// plus our injected seams (the credential store; resolved color capability).
export interface AppContext extends ApplicationContext {
  readonly store: CredentialStore;
  readonly colorEnabled: boolean;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

function colorDisabledByEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  // NO_COLOR (no-color.org): present and non-empty disables color, regardless of the value
  // — so NO_COLOR=0 still disables. STRICLI_NO_COLOR is stricli's own var with the narrower
  // "set and non-0" rule. The two semantics differ, so they're checked separately.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  return isTruthyEnv(env.STRICLI_NO_COLOR);
}

function resolveColor(proc: HostProcess): boolean {
  if (colorDisabledByEnv(proc.env)) return false;
  const depth = proc.stdout.getColorDepth?.(proc.env) ?? 1;
  return depth > 4;
}

export function buildContext(proc: HostProcess, opts?: { homedir?: string }): AppContext {
  const home = opts?.homedir ?? osHomedir();
  const configDir = resolveConfigDir(proc.env, home);
  const store = resolveStore(
    [createEnvBackend(proc.env), createFileBackend({ dir: configDir, platform: proc.platform })],
    { requireSecureStorage: isTruthyEnv(proc.env[REQUIRE_SECURE_STORAGE_VAR]) },
  );
  return {
    process: {
      stdout: proc.stdout,
      stderr: proc.stderr,
      env: proc.env,
      get exitCode() {
        return proc.exitCode;
      },
      set exitCode(value: number | string | null | undefined) {
        proc.exitCode = value;
      },
    },
    store,
    colorEnabled: resolveColor(proc),
  };
}

// Test helper: a context with capture buffers for stdout/stderr and a store rooted at a
// non-existent home (commands under test don't touch disk). Returns accessors that join the
// captured writes.
export function makeTestContext(opts?: {
  env?: Record<string, string | undefined>;
  homedir?: string;
}): { ctx: AppContext; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const proc: HostProcess = {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    env: opts?.env ?? {},
    platform: "linux",
    exitCode: undefined,
  };
  const ctx = buildContext(proc, { homedir: opts?.homedir ?? "/nonexistent-wbhk-test-home" });
  return { ctx, stdout: () => out.join(""), stderr: () => err.join("") };
}
