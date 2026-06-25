import { homedir as osHomedir } from "node:os";

import type { ApplicationContext } from "@stricli/core";

import { createEnvBackend } from "./config/env-store.js";
import { KeychainUnavailableError } from "./config/errors.js";
import { createFileBackend } from "./config/file-store.js";
import { createKeychainBackend, type KeychainIo } from "./config/keychain-store.js";
import { resolveConfigDir } from "./config/paths.js";
import { resolveStore, type CredentialStore } from "./config/store.js";
import { makeRealIo } from "./io.js";
import type { TelemetryEvent } from "./telemetry.js";

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

/**
 * A transient localhost HTTP server for the loopback OAuth redirect (RFC 8252 §8.3). Bound to the
 * `127.0.0.1` IP LITERAL on an ephemeral port (never `localhost`/`0.0.0.0`, so no other interface can
 * intercept the code). `waitForCallback` resolves with the redirect's query (`code`+`state`, or
 * `error`+`state`) once the browser hits `/callback`; the server serves its own "you can close this tab"
 * page. Injected so `login` is unit-tested with a fake (no real socket). Always `close()`d by the caller.
 */
export interface LoopbackServer {
  readonly port: number;
  waitForCallback(): Promise<URLSearchParams>;
  close(): void;
}

/** Callbacks the raw-mode terminal drives the in-tail TUI with: a decoded key chunk arrived, or the
 *  terminal was resized. (Structurally compatible with the TUI runner's input handlers.) */
export interface RawInputHandlers {
  onKey(chunk: string): void;
  onResize(): void;
}

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
  /** Prompt on stderr and read one ECHOING line from stdin (a visible destructive-action confirmation). */
  promptLine(message: string): Promise<string>;
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
  /** Start the loopback redirect server for the browser OAuth flow (a real http server in prod; a fake
   *  in tests). Bound to the `127.0.0.1` IP literal on an ephemeral port. */
  startLoopbackServer(): Promise<LoopbackServer>;
  /** Open `initialContent` in `editorCommand` (`$VISUAL`/`$EDITOR`) and resolve the saved text — the
   *  `replay --edit` round-trip. The real impl writes a 0600 temp file and spawns the editor on the TTY;
   *  a fake supplies the edited text in tests. */
  editText(initialContent: string, editorCommand: string): Promise<string>;
  /** Whether BOTH stdin and stdout are TTYs — the in-tail TUI takes over the screen, so it gates on both. */
  readonly isTTY: boolean;
  /** Current terminal size (columns × rows) — drives the TUI viewport + scrolling. */
  terminalSize(): { columns: number; rows: number };
  /** Put stdin in raw mode and deliver decoded key chunks + SIGWINCH resizes to the TUI; the returned
   *  handle restores cooked mode + removes the listeners on close(). Real impl in io.ts (coverage-excluded). */
  startRawInput(handlers: RawInputHandlers): { close(): void };
  /** Atomically replace the executable at `targetPath` with `data` (`wbhk upgrade`'s self-update): write a
   *  temp file in the same dir, chmod +x, rename over the target, and clear the macOS quarantine flag. The
   *  real impl in io.ts is coverage-excluded wiring; a fake records the call in tests. */
  replaceExecutable(targetPath: string, data: Uint8Array): Promise<void>;
  /** Verify a downloaded binary's sigstore-signed SLSA build provenance by its sha256 (`wbhk upgrade`):
   *  fetch the GitHub attestation + verify it was built by this repo's release workflow + attests this
   *  digest. Throws on any failure. Real impl in io.ts (coverage-excluded — network + the sigstore stack);
   *  a fake passes/throws in tests. */
  verifyBinaryProvenance(opts: { digestHex: string }): Promise<void>;
  /** Send one anonymous telemetry event — a fire-and-forget POST to the collector that NEVER throws or
   *  blocks (short timeout, all errors swallowed). Real impl in io.ts (coverage-excluded); a fake records
   *  the call in tests. */
  sendTelemetry(event: TelemetryEvent): Promise<void>;
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
  /** CPU architecture (process.arch) — selects the release asset for `wbhk upgrade`. */
  readonly arch: string;
  /** Path to the running executable (process.execPath) — the self-replace target for `wbhk upgrade`. */
  readonly execPath: string;
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
  /** CPU architecture (process.arch) — selects the release asset for `wbhk upgrade`. */
  readonly arch: string;
  /** Path to the running executable (process.execPath) — the self-replace target for `wbhk upgrade`. */
  readonly execPath: string;
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
    arch: proc.arch,
    execPath: proc.execPath,
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
  /** What `io.promptLine()` resolves to (the destructive-confirm path); also implies isInteractive. */
  lineResponse?: string;
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
  /** Fake loopback redirect server for `login` (the browser OAuth flow); defaults to unconfigured. */
  startLoopbackServer?: () => Promise<LoopbackServer>;
  /** Fake `$EDITOR` round-trip for `replay --edit` (returns the "edited" text); defaults to unconfigured. */
  editText?: (initialContent: string, editorCommand: string) => Promise<string>;
  /** Whether both streams are TTYs — gates the in-tail TUI hand-off (defaults to false: plain tail). */
  isTTY?: boolean;
  /** Fake terminal size for the TUI (defaults to 80×24). */
  terminalSize?: () => { columns: number; rows: number };
  /** Fake raw-mode input for the TUI (captures handlers so a test can drive keys); defaults to unconfigured. */
  startRawInput?: (handlers: RawInputHandlers) => { close(): void };
  /** CPU arch reported on the context (defaults to "x64") — `wbhk upgrade` asset selection. */
  arch?: string;
  /** Running-executable path reported on the context (defaults to a fake binary) — `wbhk upgrade` target. */
  execPath?: string;
  /** Fake self-replace for `wbhk upgrade` (records the call); defaults to unconfigured. */
  replaceExecutable?: (targetPath: string, data: Uint8Array) => Promise<void>;
  /** Fake provenance verification for `wbhk upgrade` (resolve = verified, reject = failed); defaults to a
   *  no-op that "passes" so most upgrade tests don't have to wire it. */
  verifyBinaryProvenance?: (opts: { digestHex: string }) => Promise<void>;
  /** Fake telemetry sender (records the event); defaults to a no-op. */
  sendTelemetry?: (event: TelemetryEvent) => Promise<void>;
}): { ctx: AppContext; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const proc: HostProcess = {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    env: opts?.env ?? {},
    platform: "linux",
    arch: opts?.arch ?? "x64",
    execPath: opts?.execPath ?? "/nonexistent-wbhk-test-home/.local/bin/wbhk",
    exitCode: undefined,
  };
  const unconfigured = (name: string) => (): never => {
    throw new Error(`test io.${name} not configured`);
  };
  const io: IoSeams = {
    fetch: opts?.fetch ?? (unconfigured("fetch") as unknown as typeof fetch),
    isInteractive:
      opts?.isInteractive ??
      (opts?.promptResponse !== undefined || opts?.lineResponse !== undefined),
    promptSecret:
      opts?.promptResponse !== undefined
        ? async () => opts.promptResponse as string
        : unconfigured("promptSecret"),
    promptLine:
      opts?.lineResponse !== undefined
        ? async () => opts.lineResponse as string
        : unconfigured("promptLine"),
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
    startLoopbackServer:
      opts?.startLoopbackServer ??
      (unconfigured("startLoopbackServer") as unknown as () => Promise<LoopbackServer>),
    editText: opts?.editText ?? (unconfigured("editText") as unknown as IoSeams["editText"]),
    isTTY: opts?.isTTY ?? false,
    terminalSize: opts?.terminalSize ?? (() => ({ columns: 80, rows: 24 })),
    startRawInput:
      opts?.startRawInput ?? (unconfigured("startRawInput") as unknown as IoSeams["startRawInput"]),
    replaceExecutable:
      opts?.replaceExecutable ??
      (unconfigured("replaceExecutable") as unknown as IoSeams["replaceExecutable"]),
    // Defaults to "verified" so existing upgrade tests don't need to wire it; a provenance-specific test
    // passes a fake that rejects.
    verifyBinaryProvenance: opts?.verifyBinaryProvenance ?? (async () => {}),
    sendTelemetry: opts?.sendTelemetry ?? (async () => {}),
  };
  const ctx = buildContext(proc, {
    homedir: opts?.homedir ?? "/nonexistent-wbhk-test-home",
    io,
    store: opts?.store,
  });
  return { ctx, stdout: () => out.join(""), stderr: () => err.join("") };
}
