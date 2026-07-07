import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import { renderUsageSummary } from "../output/render.js";
import { authedClient } from "./shared.js";

// `wbhk usage` — the org's metering usage for the current billing period (single dimension = events;
// the billable unit is disclosed). A read; `--output json` emits the raw UsageSummary.

type UsageFlags = GlobalFlags;

export const usageGetCommand = buildCommand<UsageFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const usage = await client.usageGet();
    this.process.stdout.write(
      format === "json" ? `${renderJson(usage)}\n` : `${renderUsageSummary(usage, color)}\n`,
    );
  },
  parameters: {
    flags: { ...globalFlags },
  },
  docs: { brief: "show the org's metering usage for the current billing period" },
});
