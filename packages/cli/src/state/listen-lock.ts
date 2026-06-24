import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../errors.js";
import { EXIT } from "../output/exit-codes.js";

// A client-side, best-effort single-listener lock for `wbhk listen --resume`. Two concurrent resuming
// listeners on the same (profile, endpoint) both persist the cursor file and race it (atomic writes prevent
// corruption, but last-finisher wins → a re-delivery window). The server has no single-listener
// enforcement, so this is a courtesy guard, not correctness. An O_EXCL lockfile in the same per-(profile,
// endpoint) state layout as the cursor (cursor-store.ts) handles the realistic footgun — one human
// double-running the command — with zero deps. A lock left by a crashed run (kill -9) is reclaimed by the
// next run once its holder pid is seen to be dead.

const DIR_NAME = "listen";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The lock path for a (profile, endpoint) — alongside the cursor, traversal-safe via encodeURIComponent. */
export function listenLockPath(stateDir: string, profile: string, endpointId: string): string {
  const name = `${encodeURIComponent(profile)}__${encodeURIComponent(endpointId)}.lock`;
  return join(stateDir, DIR_NAME, name);
}

/** Thrown when another live listener already holds the lock — a CliError so the app prints it on-voice. */
export class ListenLockedError extends CliError {
  readonly exitCode = EXIT.LISTENER_BUSY;
  readonly userMessage: string;
  constructor(holderPid: number | null) {
    const who = holderPid !== null ? ` (pid ${holderPid})` : "";
    const message = `another \`wbhk listen --resume\` is already running for this profile + endpoint${who} — stop it first, or run without --resume`;
    super(message);
    this.userMessage = message;
  }
}

/** A held lock; `release()` removes it (idempotent, best-effort). */
export interface ListenLock {
  release(): Promise<void>;
}

/** Default liveness probe: signal 0 tests existence. ESRCH = no such process (dead); EPERM = it exists but
 *  isn't ours (alive). Any other error → treat as alive (be conservative — don't steal a maybe-live lock). */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readHolderPid(path: string): Promise<number | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from the encoded state path
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null; // missing / unreadable / non-JSON → treat as no usable holder (stale)
  }
}

/**
 * Acquire the single-listener lock for a (profile, endpoint), or throw ListenLockedError if a LIVE listener
 * holds it. An O_EXCL create wins the lock atomically; on EEXIST we read the holder pid — if it's alive the
 * lock is held (throw), if it's dead/unreadable the lock is stale (reclaim + retry once). `pid`/`isAlive`/
 * `now` are injected so this is unit-tested with a real tmpdir + no real processes.
 */
export async function acquireListenLock(
  stateDir: string,
  profile: string,
  endpointId: string,
  opts?: { pid?: number; isAlive?: (pid: number) => boolean; now?: () => number },
): Promise<ListenLock> {
  const path = listenLockPath(stateDir, profile, endpointId);
  const pid = opts?.pid ?? process.pid;
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  const now = opts?.now ?? Date.now;
  const dir = join(stateDir, DIR_NAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG state, never raw user input
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG state
  await chmod(dir, DIR_MODE); // mkdir's mode is umask-masked + only-on-create; re-tighten a pre-existing dir

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" = O_CREAT | O_EXCL — fails if the file exists, so exactly one caller wins.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from the encoded state path
      const handle = await open(path, "wx", FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify({ pid, since: now() })}\n`);
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from the encoded state path
          await unlink(path).catch(() => {}); // best-effort: a reclaimed/removed lock is fine
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holderPid = await readHolderPid(path);
      if (holderPid !== null && isAlive(holderPid)) throw new ListenLockedError(holderPid);
      // stale (dead or unreadable holder) → reclaim and retry the create once
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from the encoded state path
      await unlink(path).catch(() => {});
    }
  }
  // Lost a reclaim race against another starting listener — treat as busy rather than spin.
  throw new ListenLockedError(null);
}
