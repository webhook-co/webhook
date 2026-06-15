#!/usr/bin/env node
import { run } from "@stricli/core";

import { app } from "./app.js";
import { buildContext } from "./context.js";
import { normalizeStricliExitCode } from "./output/exit-codes.js";

// The executable shell: build the real context from Node's process, run the app, and map
// stricli's result to a stable POSIX exit code. Kept thin (coverage-excluded) — all logic
// lives in the testable modules above. We set process.exitCode (not process.exit) so any
// buffered output flushes before the process ends.
const ctx = buildContext(process);
await run(app, process.argv.slice(2), ctx);
process.exitCode = normalizeStricliExitCode(ctx.process.exitCode);
