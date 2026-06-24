import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

// Cross-run resume state: the last durable cursor `wbhk listen` acked, per (profile, endpoint), so a
// later `--resume` picks up where the previous run stopped. It lives in the XDG STATE dir (durable,
// not a cache) as a per-pair JSON file. The stored value is the OPAQUE event cursor — never the
// sessionId (a sessionId is a connection handle, not a resume point). A read is corruption-tolerant:
// anything unreadable/invalid/mismatched returns a typed result the caller treats as a cold start, so a
// damaged state file degrades to "tail from now", never a crash. Writes are atomic (temp-in-same-dir +
// fsync + rename) so a crash mid-write can't leave a half-written cursor. Modeled on file-store.ts:
// node:fs directly (real-tmpdir tested), 0700 dir / 0600 file.

const DIR_NAME = "listen";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const CURSOR_VERSION = 1 as const;

const CursorRecordSchema = z.object({
  version: z.literal(CURSOR_VERSION),
  endpointId: z.string().min(1),
  cursor: z.string().min(1),
});

/** The state-file path for a (profile, endpoint). Both segments are percent-encoded, so a hostile
 *  profile/endpoint name (slashes, `..`) can't escape `<stateDir>/listen/`. */
export function cursorFilePath(stateDir: string, profile: string, endpointId: string): string {
  const name = `${encodeURIComponent(profile)}__${encodeURIComponent(endpointId)}.json`;
  return join(stateDir, DIR_NAME, name);
}

/** The outcome of loading a persisted cursor: a hit, no stored cursor, or an unusable file. */
export type CursorLoad =
  | { readonly kind: "hit"; readonly cursor: string }
  | { readonly kind: "miss" }
  | { readonly kind: "corrupt"; readonly detail: string };

/**
 * Load the persisted cursor for a (profile, endpoint). `miss` when none is stored; `corrupt` (with a
 * reason) for unreadable JSON, a schema/version mismatch, or a stored endpointId that doesn't match the
 * request (defense-in-depth — the filename already keys on it). The caller cold-starts on miss/corrupt.
 */
export async function loadCursor(
  stateDir: string,
  profile: string,
  endpointId: string,
): Promise<CursorLoad> {
  const path = cursorFilePath(stateDir, profile, endpointId);
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from XDG state + encoded segments, never raw user input
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "miss" };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "corrupt", detail: (err as Error).message };
  }
  const result = CursorRecordSchema.safeParse(parsed);
  if (!result.success) return { kind: "corrupt", detail: result.error.message };
  if (result.data.endpointId !== endpointId) {
    return { kind: "corrupt", detail: "stored cursor belongs to a different endpoint" };
  }
  return { kind: "hit", cursor: result.data.cursor };
}

/**
 * Persist the cursor for a (profile, endpoint), atomically: write a uniquely-named temp file in the
 * SAME directory (so the rename can't cross a filesystem), fsync it, then rename over the target — a
 * crash leaves either the old file or the new one, never a partial. The temp suffix is a uuid so two
 * concurrent writers can't clobber each other's temp.
 */
export async function saveCursor(
  stateDir: string,
  profile: string,
  endpointId: string,
  cursor: string,
): Promise<void> {
  const dir = join(stateDir, DIR_NAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG state, never raw user input
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode only applies on creation (and is umask-masked), so a pre-existing listen/ may be loose:
  // re-tighten it (mirrors file-store.ts). chmod adjusts only the read-only bit on Windows, so this is
  // safe cross-platform. The cursor file itself is always created 0600 (umask can't loosen owner bits).
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG state
  await chmod(dir, DIR_MODE);
  const path = cursorFilePath(stateDir, profile, endpointId);
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  const data = `${JSON.stringify({ version: CURSOR_VERSION, endpointId, cursor })}\n`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tmp derives from the encoded path, never raw user input
  const handle = await open(tmp, "w", FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync(); // flush to disk before the rename, so the rename publishes durable bytes
  } finally {
    await handle.close();
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths derive from the encoded path
  await rename(tmp, path);
  // Best-effort fsync of the PARENT DIR so the rename itself is durable (the temp's bytes were fsync'd
  // above, but the directory entry that publishes them isn't durable until the dir is synced). Swallow
  // failures: the cursor is a regenerable resume hint (a lost rename just resumes from a touch earlier),
  // and dir-fsync isn't supported everywhere (e.g. Windows can't open a dir handle).
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG state
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* dir fsync unsupported / failed — acceptable for a regenerable hint */
  }
}

/** Forget the persisted cursor for a (profile, endpoint) — the `--reset` path. A no-op when absent. */
export async function clearCursor(
  stateDir: string,
  profile: string,
  endpointId: string,
): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from XDG state + encoded segments
    await unlink(cursorFilePath(stateDir, profile, endpointId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
