import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { text } from "node:stream/consumers";

import { SERVICE_NAME } from "@webhook-co/shared";
import { WebSocket as WsWebSocket } from "ws";

import { KeychainUnavailableError } from "./config/errors.js";
import type { KeychainIo } from "./config/keychain-store.js";
import type { IoSeams } from "./context.js";

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

/** Build the production IoSeams from process globals. */
export function makeRealIo(): IoSeams {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    isInteractive: process.stdin.isTTY === true,
    promptSecret,
    readStdin: async () => (await text(process.stdin)).trim(),
    // The `ws` client can set the upgrade Authorization header (the global WHATWG WebSocket can't),
    // and works under both Node and the Bun-compiled binary. Text frames arrive as Buffer → string.
    connectWebSocket: (url, { headers, handlers }) => {
      const ws = new WsWebSocket(url, { headers });
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
