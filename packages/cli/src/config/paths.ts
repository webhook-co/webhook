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
