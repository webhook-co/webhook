import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { EXIT } from "../output/exit-codes.js";
import { renderJson } from "../output/format.js";
import { renderAuditResult } from "../output/render.js";
import { authedClient } from "./shared.js";

// `wbhk audit verify` — walk the org's tamper-evident audit chain (ADR-0004) and report the first
// break, if any. The call succeeds (HTTP 200) even on a break, so a DETECTED break is signaled by a
// non-zero exit (EXIT.AUDIT_BREAK) — set on the context so a cron/CI run alerts — while the result is
// still printed to stdout in both modes. `--output json` emits the raw discriminated-union result.

type AuditFlags = GlobalFlags;

export const auditVerifyCommand = buildCommand<AuditFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await client.auditVerify();
    this.process.stdout.write(
      format === "json" ? `${renderJson(result)}\n` : `${renderAuditResult(result, color)}\n`,
    );
    // A detected break is a meaningful non-zero exit (not an error result — the request itself
    // returned 200). stricli sets the exit code with `??=`, so this manual value survives.
    if (!result.ok) this.process.exitCode = EXIT.AUDIT_BREAK;
  },
  parameters: {
    flags: { ...globalFlags },
  },
  docs: { brief: "verify the org's tamper-evident audit chain" },
});
