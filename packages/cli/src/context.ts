import { homedir as osHomedir } from "node:os";

import type { ApplicationContext } from "@stricli/core";

import { createEnvBackend } from "./config/env-store.js";
import { KeychainUnavailableError } from "./config/errors.js";
import { createFileBackend } from "./config/file-store.js";
import { createKeychainBackend, type KeychainIo } from "./config/keychain-store.js";
import { resolveConfigDir } from "./config/paths.js";
import { resolveStore, type CredentialStore } from "./config/store.js";
import { makeRealIo } from "./io.js";

/** Env var that forces a hard fail rather than persisting a plaintext credential. */
export const REQUIRE_SECURE_STORAGE_VAR = "WBHK_REQUIRE_SECURE_STORAGE";

/** Lifecycle callbacks the `wbhk listen` command drives a tunnel socket with. */
export interface WsHandlers {
  readonly onOpen: () => void;
  /** A text frame arrived (the runtime decodes Buffer/ArrayBuffer to a string first). */
  readonly onMessage: (data: string) => void;
  readonly onClose: (code: number, reason: string) => void;
  readonly onError: (err: Error) => void;
}
/** The minimal socket the listen command holds: send a frame, or close the connection. */
export interface WsSocket {
  send(data: string): void;
  close(): void;
}
/**
 * Open a WebSocket to `url` with request headers (the bearer-authed `/listen` tunnel). Injected so
 * `wbhk listen` is unit-tested with a fake socket (no network). The real impl wraps the `ws` package
 * — the global WHATWG `WebSocket` cannot set an Authorization header on the upgrade; `ws` can.
 */
export type ConnectWebSocket = (
  url: string,
  opts: { headers: Readonly<Record<string, string>>; handlers: WsHandlers },
) => WsSocket;

// The host I/O seams a command needs beyond the process streams: an HTTP client (the API), a piped-
// stdin reader (`--stdin`), an interactive hidden-secret prompt, and the listen tunnel socket. Grouped
// + injected so commands are node-tested with fakes; the real implementations (TTY + globals + the ws
// client) live in io.ts (coverage-excluded).
export interface IoSeams {
  /** HTTP client for the REST API (the runtime `fetch` in production; a fake in tests). */
  readonly fetch: typeof fetch;
  /** Whether stdin is an interactive TTY — gates whether an interactive prompt is possible. */
  readonly isInteractive: boolean;
  /** Prompt on stderr and read one line from stdin without echoing it (secret entry). */
  promptSecret(message: string): Promise<string>;
  /** Read all of piped stdin to EOF, trimmed (the `--stdin` key path). */
  readStdin(): Promise<string>;
  /** Open the bearer-authed listen tunnel WebSocket (the `ws` client in prod; a fake in tests). */
  connectWebSocket: ConnectWebSocket;
  /** OS-keychain secret storage (the macOS/Linux CLI in prod; a fake in tests). */
  readonly keychain: KeychainIo;
  /** Best-effort: open a URL in the user's default browser (the OAuth `login` convenience). */
  openBrowser(url: string): Promise<void>;
  /** Wall-clock sleep (real `setTimeout` in prod; instant under test) — the device-flow poll backoff. */
  sleep(ms: number): Promise<void>;
}

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
  readonly io: IoSeams;
  /** The resolved home directory — the base for XDG config/state/cache paths (used by `doctor`). */
  readonly homedir: string;
  /** The host platform — gates the POSIX config-permission check (used by `doctor`). */
  readonly platform: NodeJS.Platform;
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

export function buildContext(
  proc: HostProcess,
  opts?: { homedir?: string; io?: IoSeams; store?: CredentialStore },
): AppContext {
  const home = opts?.homedir ?? osHomedir();
  const configDir = resolveConfigDir(proc.env, home);
  // io is resolved before the store so the credential store can compose the OS-keychain backend (which
  // shells out via io.keychain) AHEAD of the 0600 file. Read precedence: env (CI override) › keychain
  // (secure) › file (insecure fallback). An unavailable keychain is skipped on read + falls back on write.
  const io = opts?.io ?? makeRealIo();
  const store =
    opts?.store ??
    resolveStore(
      [
        createEnvBackend(proc.env),
        createKeychainBackend({ keychainIo: io.keychain }),
        createFileBackend({ dir: configDir, platform: proc.platform }),
      ],
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
    homedir: home,
    platform: proc.platform,
    io,
  };
}

// Test helper: a context with capture buffers for stdout/stderr and a store rooted at a
// non-existent home (commands under test don't touch disk). Returns accessors that join the
// captured writes.
export function makeTestContext(opts?: {
  env?: Record<string, string | undefined>;
  homedir?: string;
  /** Fake fetch for the API client (defaults to one that throws if a command calls it unexpectedly). */
  fetch?: typeof fetch;
  /** What `io.readStdin()` resolves to (the `--stdin` path). */
  stdin?: string;
  /** What `io.promptSecret()` resolves to (the interactive path); also implies isInteractive. */
  promptResponse?: string;
  /** Whether stdin is an interactive TTY (defaults to true when promptResponse is given, else false). */
  isInteractive?: boolean;
  /** Override the credential store (an in-memory fake) so command tests never touch disk. */
  store?: CredentialStore;
  /** Fake tunnel-socket factory for `wbhk listen` (drives ready/event/close in tests). */
  connectWebSocket?: ConnectWebSocket;
  /** Fake OS keychain (defaults to "unavailable" so the default store falls back to the file, as before). */
  keychain?: KeychainIo;
  /** Fake browser-opener for `login` (records the URL); defaults to a no-op (best-effort in prod too). */
  openBrowser?: (url: string) => Promise<void>;
  /** Fake sleep (defaults to instant) so device-flow command tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
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
  const unconfigured = (name: string) => (): never => {
    throw new Error(`test io.${name} not configured`);
  };
  const io: IoSeams = {
    fetch: opts?.fetch ?? (unconfigured("fetch") as unknown as typeof fetch),
    isInteractive: opts?.isInteractive ?? opts?.promptResponse !== undefined,
    promptSecret:
      opts?.promptResponse !== undefined
        ? async () => opts.promptResponse as string
        : unconfigured("promptSecret"),
    readStdin:
      opts?.stdin !== undefined ? async () => opts.stdin as string : unconfigured("readStdin"),
    connectWebSocket:
      opts?.connectWebSocket ?? (unconfigured("connectWebSocket") as unknown as ConnectWebSocket),
    // Default to an "unavailable" keychain so the default store transparently falls back to the file
    // (preserving pre-keychain test behavior); a test that exercises the keychain passes its own fake.
    keychain: opts?.keychain ?? {
      get: async () => {
        throw new KeychainUnavailableError();
      },
      set: async () => {
        throw new KeychainUnavailableError();
      },
      erase: async () => {
        throw new KeychainUnavailableError();
      },
    },
    openBrowser: opts?.openBrowser ?? (async () => {}),
    sleep: opts?.sleep ?? (async () => {}),
  };
  const ctx = buildContext(proc, {
    homedir: opts?.homedir ?? "/nonexistent-wbhk-test-home",
    io,
    store: opts?.store,
  });
  return { ctx, stdout: () => out.join(""), stderr: () => err.join("") };
}
