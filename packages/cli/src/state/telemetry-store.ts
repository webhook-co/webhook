import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

// Persisted telemetry preferences (DIST-14): the `wbhk telemetry on/off` override + whether the one-time
// privacy notice has been shown. A small JSON file in the config dir, separate from the credential config (so
// it sidesteps the credential CONFIG_VERSION ladder). Corruption-tolerant: anything unreadable/invalid →
// defaults (no override, not-yet-noticed), never a crash. Atomic write (temp-in-same-dir + rename), 0600.
const FILE = "telemetry.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const TELEMETRY_STATE_VERSION = 1 as const;

const TelemetryStateSchema = z.object({
  version: z.literal(TELEMETRY_STATE_VERSION),
  enabled: z.boolean().optional(), // `wbhk telemetry on/off`; undefined = default (opt-out, enabled)
  noticed: z.boolean().optional(), // whether the one-time privacy notice was shown
});

export interface TelemetryState {
  /** The explicit `wbhk telemetry on/off` choice; undefined when never set. */
  readonly enabled?: boolean;
  /** Whether the one-time privacy notice has been shown. */
  readonly noticed: boolean;
}

export function telemetryStatePath(configDir: string): string {
  return join(configDir, FILE);
}

/** Load the persisted telemetry state; missing/unreadable/invalid → defaults (no override, not noticed). */
export async function readTelemetryState(configDir: string): Promise<TelemetryState> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is configDir (XDG) + a fixed filename
    const raw = await readFile(telemetryStatePath(configDir), "utf8");
    const parsed = TelemetryStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { noticed: false };
    return { enabled: parsed.data.enabled, noticed: parsed.data.noticed ?? false };
  } catch {
    return { noticed: false };
  }
}

async function writeTelemetryState(configDir: string, state: TelemetryState): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configDir is XDG-derived, not raw input
  await mkdir(configDir, { recursive: true, mode: DIR_MODE });
  const path = telemetryStatePath(configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({
    version: TELEMETRY_STATE_VERSION,
    enabled: state.enabled,
    noticed: state.noticed,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tmp derives from the fixed state path
  await writeFile(tmp, body, { mode: FILE_MODE });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same fixed temp path
  await chmod(tmp, FILE_MODE); // defeat any umask slack on the 0600
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed temp → fixed state path
  await rename(tmp, path);
}

/** Persist the `wbhk telemetry on|off` choice (preserving the noticed flag). */
export async function setTelemetryEnabled(configDir: string, enabled: boolean): Promise<void> {
  const current = await readTelemetryState(configDir);
  await writeTelemetryState(configDir, { ...current, enabled });
}

/** Record that the one-time privacy notice has been shown (idempotent). */
export async function markTelemetryNoticed(configDir: string): Promise<void> {
  const current = await readTelemetryState(configDir);
  if (current.noticed) return;
  await writeTelemetryState(configDir, { ...current, noticed: true });
}
