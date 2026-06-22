#!/usr/bin/env node
import { run } from "@stricli/core";

import { app } from "./app.js";
import { runCompletionProposals } from "./commands/completion.js";
import { buildContext } from "./context.js";
import { normalizeStricliExitCode } from "./output/exit-codes.js";

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
if (argv[0] === "__complete") {
  // The hidden completion engine the `wbhk completion bash` script calls on TAB. Dispatched here rather
  // than as a route so it never shows in help / its own completions, and to avoid an app↔command cycle.
  // The bash function passes `-- <words…>`; drop the leading `--` separator if present.
  const rest = argv.slice(1);
  await runCompletionProposals(app, rest[0] === "--" ? rest.slice(1) : rest, ctx);
} else {
  await run(app, argv, ctx);
}
process.exitCode = normalizeStricliExitCode(ctx.process.exitCode);
