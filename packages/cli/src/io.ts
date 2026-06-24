import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { text } from "node:stream/consumers";

import { SERVICE_NAME } from "@webhook-co/shared";
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket as WsWebSocket } from "ws";

import { KeychainUnavailableError } from "./config/errors.js";
import type { KeychainIo } from "./config/keychain-store.js";
import type { IoSeams, LoopbackServer, RawInputHandlers } from "./context.js";
import { resolveProxy } from "./proxy.js";

// The page shown in the browser tab once the OAuth redirect lands on the loopback server — Lane D's own
// (the issuer's job ends at the redirect). Static + self-contained (no remote assets); the CLI has already
// captured the code by the time this renders, so it's purely "you can go back to your terminal".
const CLOSE_TAB_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>signed in · webhook.co</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}
main{text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}</style>
</head><body><main><h1>you're signed in</h1><p>You can close this tab and return to your terminal.</p></main></body></html>`;

// Start the loopback redirect server for the browser OAuth flow. Bound to the 127.0.0.1 IP LITERAL on an
// ephemeral port (port 0 → OS-assigned) — never `localhost` (could resolve to another interface) and never
// `0.0.0.0` (would expose the code-bearing redirect to the whole network). Resolves `waitForCallback` with
// the `/callback` query the moment the browser hits it, after serving the close-tab page; other paths get a
// 404. The caller always `close()`s. No timeout here — Ctrl-C aborts a never-completed login (the process
// owns the lifetime); a bounded timeout is a possible later refinement.
function startLoopbackServer(): Promise<LoopbackServer> {
  let resolveCallback: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CLOSE_TAB_HTML);
    resolveCallback(url.searchParams);
  });
  let closed = false;
  return new Promise<LoopbackServer>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      // Past the bind: swallow any later socket 'error' (e.g. a transient runtime error) so it can't
      // crash the CLI as an unhandled event — the login simply won't get a callback (the user retries).
      server.removeListener("error", onListenError);
      server.on("error", () => {});
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        waitForCallback: () => callback,
        close: () => {
          if (closed) return; // idempotent — `close()` after a prior close would throw ERR_SERVER_NOT_RUNNING
          closed = true;
          server.close();
        },
      });
    });
  });
}

// Open `initialContent` in the user's editor and return the saved text — the `replay --edit` round-trip.
// The payload may carry PII/PHI, so the temp file is written 0600 (then chmod'd 0600 to defeat any umask
// slack) inside a private 0700 mkdtemp dir, and the dir is ALWAYS removed — on success, a non-zero editor
// exit, a spawn error, OR a setup throw (the whole body is guarded so a write/spawn failure can't leak the
// payload on disk). The editor is split on spaces (so `code --wait` / `emacs -nw` work) and spawned WITHOUT
// a shell (no injection from the editor string or the controlled temp path), inheriting the TTY so it can
// drive the terminal. A non-zero editor exit rejects (the caller aborts without forwarding).
function editText(initialContent: string, editorCommand: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "wbhk-edit-"));
      const file = join(dir, "payload");
      writeFileSync(file, initialContent, { encoding: "utf-8", mode: 0o600 });
      chmodSync(file, 0o600); // writeFileSync mode is umask-masked; chmod makes the 0600 literal
      const [cmd, ...args] = editorCommand.split(" ").filter((part) => part.length > 0);
      if (cmd === undefined) throw new Error("editor command is empty");
      const cleanup = (): void => rmSync(dir as string, { recursive: true, force: true });
      const child = spawn(cmd, [...args, file], { stdio: "inherit" });
      child.on("error", (err) => {
        cleanup();
        reject(err);
      });
      child.on("close", (code) => {
        try {
          if (code !== 0) {
            reject(new Error(`editor exited with code ${code ?? "null"}`));
            return;
          }
          resolve(readFileSync(file, "utf-8"));
        } finally {
          cleanup();
        }
      });
    } catch (err) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// The host I/O boundary: the real `fetch`, piped-stdin reader, and interactive hidden-secret prompt.
// These touch process globals + the TTY, so they live behind the injected IoSeams (commands receive
// fakes in tests) and this module is coverage-excluded (vitest.config) like bin.ts — it is wiring +
// terminal interaction, not logic. The masking behavior is a human-UI checkpoint (see ADR-0012 / PR).

/** Read one line from stdin WITHOUT echoing it — the interactive secret-entry path. */
function promptSecret(message: string): Promise<string> {
  // A muted output stream swallows the keystroke echo; the prompt itself is written to stderr (so it
  // never pollutes stdout / a piped capture). terminal:true keeps line editing (backspace) working.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  process.stderr.write(message);
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise<string>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

// Run an OS keychain CLI with args (NEVER a shell — args are passed as an array, so a profile name can't
// inject). The secret can be supplied on STDIN (no argv exposure, used for `secret-tool store`). A missing
// binary (ENOENT) becomes KeychainUnavailableError so the store falls back to the file; a non-zero exit is
// returned to the caller to interpret per-CLI (e.g. macOS exit 44 = "not found"). stderr is discarded.
function runKeychainCli(
  cmd: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" ? new KeychainUnavailableError() : err);
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    // Swallow EPIPE: if the child exits before we finish writing the secret, the stdin stream emits an
    // async 'error' that would otherwise be uncaught (the `close`/`error` on `child` already settle us).
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// The OS keychain seam: macOS `security` and Linux `secret-tool` (libsecret) round-trip a secret per
// (service, account=profile). Windows + anything else report unavailable → the store falls back to the
// 0600 file. NOTE: macOS `security add-generic-password -w <secret>` puts the secret in argv (briefly
// visible to `ps` during the write) — an inherent limitation of that CLI; `secret-tool` takes the secret
// on stdin (no exposure). Reads/erases never expose the secret. Coverage-excluded wiring (real OS calls).
function makeRealKeychainIo(): KeychainIo {
  const service = SERVICE_NAME;
  if (process.platform === "darwin") {
    return {
      async get(account) {
        const { code, stdout } = await runKeychainCli("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        if (code === 44) return null; // errSecItemNotFound
        if (code !== 0) throw new Error(`keychain read failed (security exit ${code})`);
        return stdout.replace(/\n$/, "");
      },
      async set(account, secret) {
        const { code } = await runKeychainCli("security", [
          "add-generic-password",
          "-U", // update if it already exists
          "-s",
          service,
          "-a",
          account,
          "-w",
          secret,
        ]);
        if (code !== 0) throw new Error(`keychain write failed (security exit ${code})`);
      },
      async erase(account) {
        const { code } = await runKeychainCli("security", [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          account,
        ]);
        if (code !== 0 && code !== 44)
          throw new Error(`keychain erase failed (security exit ${code})`);
      },
    };
  }
  if (process.platform === "linux") {
    return {
      async get(account) {
        const { code, stdout } = await runKeychainCli("secret-tool", [
          "lookup",
          "service",
          service,
          "account",
          account,
        ]);
        return code === 0 && stdout.length > 0 ? stdout.replace(/\n$/, "") : null;
      },
      async set(account, secret) {
        const { code } = await runKeychainCli(
          "secret-tool",
          [
            "store",
            "--label",
            `${service} cli (${account})`,
            "service",
            service,
            "account",
            account,
          ],
          secret, // on stdin — no argv exposure
        );
        if (code !== 0) throw new Error(`keychain write failed (secret-tool exit ${code})`);
      },
      async erase(account) {
        await runKeychainCli("secret-tool", ["clear", "service", service, "account", account]);
      },
    };
  }
  // No supported round-trip keychain CLI (Windows `cmdkey` can't read a secret back) → fall back to file.
  const unavailable = (): never => {
    throw new KeychainUnavailableError();
  };
  return { get: unavailable, set: unavailable, erase: unavailable };
}

// `wbhk upgrade`'s self-replace. Write the verified new bytes to a temp file in the SAME directory as the
// running binary (so the rename is atomic — same filesystem, no EXDEV), make it executable, then rename it
// over the target. On POSIX a rename-over-a-running-binary works (the live process keeps the old inode; the
// new file is in place for the next exec). On Windows a running .exe can't be overwritten in place but CAN
// be renamed, so the current binary is moved aside first. macOS quarantine is cleared best-effort so
// Gatekeeper doesn't block the new (unsigned) binary. Coverage-excluded wiring; verified by the upgrade
// command's tests via the injected seam + a human end-to-end once the first public release exists.
function replaceExecutable(targetPath: string, data: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dir = dirname(targetPath);
    const tmp = join(dir, `.wbhk-upgrade-${process.pid}-${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, data, { mode: 0o755 });
      chmodSync(tmp, 0o755); // writeFileSync mode is umask-masked; chmod makes 0755 literal (executable)
      if (process.platform === "win32") {
        const old = `${targetPath}.old`;
        try {
          rmSync(old, { force: true });
        } catch {
          /* a prior .old may still be locked by a running process — Windows reclaims it later */
        }
        renameSync(targetPath, old); // move the running .exe aside (rename is allowed while running)
        try {
          renameSync(tmp, targetPath);
        } catch (err) {
          // The new binary didn't land — restore the original so we never leave wbhk MISSING (the whole
          // point of moving it aside, not deleting it). Best-effort; rethrow the real failure either way.
          try {
            renameSync(old, targetPath);
          } catch {
            /* rollback failed too — `${targetPath}.old` holds the working binary for manual recovery */
          }
          throw err;
        }
      } else {
        renameSync(tmp, targetPath); // atomic same-fs replace
        if (process.platform === "darwin") {
          try {
            const x = spawn("xattr", ["-d", "com.apple.quarantine", targetPath], {
              stdio: "ignore",
            });
            x.on("error", () => {}); // xattr missing / attribute absent — best-effort
          } catch {
            /* ignore */
          }
        }
      }
      resolve();
    } catch (err) {
      // Don't leave the temp behind in the install dir on any failure (a successful rename already consumed
      // it; rmSync force-ignores ENOENT).
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// Open a URL in the user's default browser — best-effort, per-OS launcher, NEVER a shell (the URL is a
// plain argv element, so it can't inject). Detached + unref'd so the launcher's lifetime doesn't tie to
// the CLI. A missing launcher or any spawn error resolves quietly (the caller has already printed the URL
// as the fallback, and only same-origin issuer http(s) URLs reach here — see device-login isIssuerOrigin).
// Windows uses `rundll32 url.dll,FileProtocolHandler <url>` rather than `cmd /c start` to keep the URL a
// clean argv element (cmd.exe's own parser treats `&` etc. specially even with an argv array).
function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve()); // no launcher (ENOENT) etc. — the printed URL is the fallback
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

// Raw-mode stdin for the in-tail TUI. Puts the terminal in raw mode (arrows/keys arrive as byte chunks;
// ISIG off, so Ctrl-C is delivered as the key \x03 — the TUI maps it to quit, not a signal), decodes each
// chunk to a string, and fires onResize on the stdout SIGWINCH. close() removes both listeners + restores
// cooked mode (idempotent). Coverage-excluded terminal interaction (the TUI render/logic is tested via run.ts).
function startRawInput(handlers: RawInputHandlers): { close(): void } {
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf-8");
  const onData = (chunk: string): void => handlers.onKey(chunk);
  const onResize = (): void => handlers.onResize();
  stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      stdin.setRawMode?.(false);
      stdin.pause();
    },
  };
}

/** Build the production IoSeams from process globals. */
export function makeRealIo(): IoSeams {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    isInteractive: process.stdin.isTTY === true,
    promptSecret,
    readStdin: async () => (await text(process.stdin)).trim(),
    openBrowser,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    startLoopbackServer,
    editText,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    terminalSize: () => ({
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }),
    startRawInput,
    replaceExecutable,
    // The `ws` client can set the upgrade Authorization header (the global WHATWG WebSocket can't),
    // and works under both Node and the Bun-compiled binary. Text frames arrive as Buffer → string.
    // Unlike fetch (which the runtime proxies from env natively), `ws` never auto-proxies — so resolve the
    // proxy for this tunnel URL from the env and route the upgrade through an HTTPS_PROXY CONNECT agent.
    connectWebSocket: (url, { headers, handlers }) => {
      const proxyUrl = resolveProxy(url, process.env);
      const agent = proxyUrl !== undefined ? new HttpsProxyAgent(proxyUrl) : undefined;
      const ws = new WsWebSocket(url, agent !== undefined ? { headers, agent } : { headers });
      ws.on("open", () => handlers.onOpen());
      ws.on("message", (data) => handlers.onMessage(data.toString()));
      ws.on("close", (code, reason) => handlers.onClose(code, reason.toString()));
      ws.on("error", (err) =>
        handlers.onError(err instanceof Error ? err : new Error(String(err))),
      );
      // send/close can throw on a non-OPEN socket (a routine drop). Swallow so the throw never escapes
      // the `ws` event callback as an uncaught exception — the reconnect loop recovers and at-least-once
      // redelivers any un-acked event. Mirrors the DO's safeSend.
      return {
        send: (data: string) => {
          try {
            ws.send(data);
          } catch {
            /* socket not open; reconnect + redelivery recovers */
          }
        },
        close: () => {
          try {
            ws.close();
          } catch {
            /* already closing/closed */
          }
        },
      };
    },
    keychain: makeRealKeychainIo(),
  };
}
