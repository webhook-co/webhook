#!/usr/bin/env node
import { homedir } from "node:os";

import { run } from "@stricli/core";

import { app } from "./app.js";
import { runCompletionProposals } from "./commands/completion.js";
import { resolveConfigDir } from "./config/paths.js";
import { buildContext } from "./context.js";
import { normalizeStricliExitCode } from "./output/exit-codes.js";
import { markTelemetryNoticed, readTelemetryState } from "./state/telemetry-store.js";
import { buildTelemetryEvent, resolveTelemetryEnabled, TELEMETRY_NOTICE } from "./telemetry.js";
import { VERSION } from "./version.js";

// The executable shell: build the real context from Node's process, run the app, and map
// stricli's result to a stable POSIX exit code. Kept thin (coverage-excluded) — all logic
// lives in the testable modules above. We set process.exitCode (not process.exit) so any
// buffered output flushes before the process ends.

// Exit quietly on a broken pipe (e.g. `wbhk events list | head`) instead of crashing with an EPIPE
// stack — the downstream reader closed early, which is success from the caller's point of view. (The
// pipe is gone, so there is nothing left to flush; an immediate exit is correct here.)
const exitQuietlyOnEpipe = (stream: NodeJS.WriteStream): void => {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
};
exitQuietlyOnEpipe(process.stdout);
exitQuietlyOnEpipe(process.stderr);

const ctx = buildContext(process);
const argv = process.argv.slice(2);
const startedAt = Date.now();
if (argv[0] === "__complete") {
  // The hidden completion engine the shell completion scripts (bash/zsh/fish) call on TAB. Dispatched here
  // rather than as a route so it never shows in help / its own completions, and to avoid an app↔command
  // cycle. The scripts pass `-- <words…>`; drop the leading `--` separator if present.
  const rest = argv.slice(1);
  await runCompletionProposals(app, rest[0] === "--" ? rest.slice(1) : rest, ctx);
} else {
  await run(app, argv, ctx);
}
const exit = normalizeStricliExitCode(ctx.process.exitCode);

// Anonymous, opt-out usage telemetry (DIST-14) — best-effort, NEVER affects the command (all wrapped). The
// pure opt-out + event-shape logic is in telemetry.ts; here we resolve it, show the one-time notice, and
// fire-and-forget. Skipped for the hidden completion engine (TAB completions must be instant + silent). We
// don't await the send: the CLI sets process.exitCode (not process.exit), so the loop drains the pending POST.
if (argv[0] !== "__complete") {
  try {
    const configDir = resolveConfigDir(process.env, homedir());
    const state = await readTelemetryState(configDir);
    if (resolveTelemetryEnabled({ env: process.env, stored: state.enabled })) {
      if (!state.noticed) {
        process.stderr.write(TELEMETRY_NOTICE);
        await markTelemetryNoticed(configDir);
      }
      void ctx.io.sendTelemetry(
        buildTelemetryEvent({
          version: VERSION,
          platform: process.platform,
          arch: process.arch,
          argv,
          exitCode: exit,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  } catch {
    /* telemetry must never affect the command */
  }
}
process.exitCode = exit;
