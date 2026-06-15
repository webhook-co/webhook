import type { Stats } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConfigNotFoundError,
  CorruptConfigError,
  InsecureConfigPermissionsError,
} from "./errors.js";
import { ConfigFileSchema, emptyConfig, type ConfigFile } from "./schema.js";
import type { CredentialBackend } from "./store.js";

const FILE_NAME = "config.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function configFilePath(dir: string): string {
  return join(dir, FILE_NAME);
}

interface FsOptions {
  readonly platform: NodeJS.Platform;
}

function isPosix(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

async function statFile(path: string): Promise<Stats> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from XDG/home + a constant filename, never user input
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigNotFoundError();
    throw err;
  }
}

/**
 * Read + validate the config file. Throws ConfigNotFoundError (absent),
 * InsecureConfigPermissionsError (group/other-readable on POSIX), or CorruptConfigError
 * (bad JSON / schema mismatch). The single trusted read boundary.
 */
export async function loadConfigFile(path: string, opts: FsOptions): Promise<ConfigFile> {
  const stats = await statFile(path);
  if (isPosix(opts.platform) && (stats.mode & 0o077) !== 0) {
    throw new InsecureConfigPermissionsError(stats.mode & 0o777, path);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above; CLI-owned path, not user-supplied
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptConfigError((err as Error).message);
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) throw new CorruptConfigError(result.error.message);
  return result.data;
}

// The 0600-file backend: the last-resort, honestly-insecure fallback (secure=false). Dir
// is created 0700 and the file 0600; permissions are re-tightened on every write in case
// the file pre-existed loose. Corrupt/insecure reads surface so the user fixes them; a
// simply-absent file reads as "no credential yet".
export function createFileBackend(opts: { dir: string } & FsOptions): CredentialBackend {
  const path = configFilePath(opts.dir);

  async function readOrEmpty(): Promise<ConfigFile> {
    try {
      return await loadConfigFile(path, opts);
    } catch (err) {
      if (err instanceof ConfigNotFoundError) return emptyConfig();
      throw err;
    }
  }

  async function write(config: ConfigFile): Promise<void> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from XDG/home, never user input
    await mkdir(opts.dir, { recursive: true, mode: DIR_MODE });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
    if (isPosix(opts.platform)) {
      // writeFile's mode only applies on creation (and is umask-masked); re-tighten explicitly.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      await chmod(path, FILE_MODE);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      await chmod(opts.dir, DIR_MODE);
    }
  }

  return {
    id: "file",
    secure: false,
    canWrite: true,
    async get(profile) {
      const config = await readOrEmpty();
      return config.profiles[profile]?.credential ?? null;
    },
    async set(profile, cred) {
      const config = await readOrEmpty();
      const existing = config.profiles[profile] ?? {};
      config.profiles[profile] = { ...existing, credential: cred };
      await write(config);
    },
    async erase(profile) {
      const config = await readOrEmpty();
      if (config.profiles[profile] === undefined) return;
      delete config.profiles[profile];
      await write(config);
    },
    async list() {
      const config = await readOrEmpty();
      return Object.keys(config.profiles);
    },
  };
}
