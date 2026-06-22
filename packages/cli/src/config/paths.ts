import { join } from "node:path";

import { SERVICE_NAME } from "@webhook-co/shared";

// XDG-first config directory resolution (the dev-tool convention: `gh`, `kubectl`, etc.).
// `$XDG_CONFIG_HOME/webhook` when set, else `~/.config/webhook`. The service name comes
// from the shared constant so the CLI and the rest of the stack agree on the brand dir.
export function resolveConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir, ".config");
  return join(base, SERVICE_NAME);
}

// XDG state dir — durable, machine-local state that isn't config and isn't a cache (the cross-run
// listen cursor lands here in D6). `$XDG_STATE_HOME/webhook`, else `~/.local/state/webhook` (freedesktop).
export function resolveStateDir(
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir, ".local", "state");
  return join(base, SERVICE_NAME);
}

// XDG cache dir — regenerable, safe-to-delete scratch. `$XDG_CACHE_HOME/webhook`, else `~/.cache/webhook`.
export function resolveCacheDir(
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir, ".cache");
  return join(base, SERVICE_NAME);
}
