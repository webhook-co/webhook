import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The last version advisory the API sent us, cached so it can be SHOWN on a later run.
//
// Why cache at all? The advisory is server-driven — it rides a response to a command that actually called
// the API. But `wbhk -v` (the very command someone runs to ask "am I current?") makes NO request, so it has
// nothing to react to. Caching lets `-v` answer honestly without the CLI ever polling npm behind your back.
//
// Corruption-tolerant, exactly like the telemetry store: anything unreadable/invalid → "no advisory", never
// a crash. A cache that can brick the CLI would be far worse than a missed nudge.

export const ADVISORY_STATE_VERSION = 1 as const;

export interface CachedAdvisory {
  readonly deprecated: boolean;
  /** The version WE were on when the server advised us. Stale advice is discarded — see isStillRelevant. */
  readonly current: string;
  readonly latest: string;
}

interface AdvisoryFile {
  version: number;
  advisory?: CachedAdvisory;
}

function advisoryPath(stateDir: string): string {
  return join(stateDir, "advisory.json");
}

/** Read the cached advisory. Anything unreadable or malformed reads as "none". */
export async function readAdvisory(stateDir: string): Promise<CachedAdvisory | null> {
  try {
    const raw = await readFile(advisoryPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as AdvisoryFile;
    const advisory = parsed?.advisory;
    if (
      typeof advisory?.latest !== "string" ||
      typeof advisory?.current !== "string" ||
      typeof advisory?.deprecated !== "boolean"
    ) {
      return null;
    }
    return advisory;
  } catch {
    return null; // absent, unreadable, or corrupt — never a crash
  }
}

/** Persist the advisory (atomic temp-then-rename, 0600 dir), best-effort. */
export async function writeAdvisory(stateDir: string, advisory: CachedAdvisory): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file: AdvisoryFile = { version: ADVISORY_STATE_VERSION, advisory };
    const tmp = `${advisoryPath(stateDir)}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, advisoryPath(stateDir));
  } catch {
    // A read-only HOME or a full disk must never fail a command over a nudge.
  }
}

/**
 * Is a cached advisory still worth showing?
 *
 * It is NOT, once the running version has moved on: after `wbhk upgrade`, a cached "0.2.0 → 0.3.0" would
 * otherwise keep nagging someone who is already on 0.3.0 — the classic stale-notifier bug that teaches
 * people to ignore the box.
 */
export function isStillRelevant(advisory: CachedAdvisory, runningVersion: string): boolean {
  return advisory.current === runningVersion && advisory.latest !== runningVersion;
}
