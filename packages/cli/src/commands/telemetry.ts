import { buildCommand, buildRouteMap } from "@stricli/core";

import { resolveConfigDir } from "../config/paths.js";
import type { AppContext } from "../context.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import { readTelemetryState, setTelemetryEnabled } from "../state/telemetry-store.js";
import { resolveTelemetryEnabled } from "../telemetry.js";

// `wbhk telemetry on|off|status` — manage the anonymous, opt-out usage telemetry. The persisted on/off choice
// lives in a small config-dir state file; env (`WBHK_TELEMETRY` / `DO_NOT_TRACK`) and CI override it at
// resolve time. See telemetry.ts for exactly what's collected (anonymous; never args/PII).

async function persist(ctx: AppContext, enabled: boolean): Promise<void> {
  const configDir = resolveConfigDir(ctx.process.env ?? {}, ctx.homedir);
  await setTelemetryEnabled(configDir, enabled);
  ctx.process.stdout.write(
    `telemetry ${enabled ? "enabled" : "disabled"}.\n` +
      (enabled
        ? "anonymous: which commands, cli version, OS/arch — never your data, args, or credentials.\n"
        : ""),
  );
}

const onCommand = buildCommand<GlobalFlags, [], AppContext>({
  async func(this: AppContext) {
    await persist(this, true);
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "enable anonymous usage telemetry" },
});

const offCommand = buildCommand<GlobalFlags, [], AppContext>({
  async func(this: AppContext) {
    await persist(this, false);
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "disable telemetry" },
});

const statusCommand = buildCommand<GlobalFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const { format } = resolveGlobals(this, flags);
    const env = this.process.env ?? {};
    const state = await readTelemetryState(resolveConfigDir(env, this.homedir));
    const enabled = resolveTelemetryEnabled({ env, stored: state.enabled });
    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ enabled })}\n`
        : `telemetry is ${enabled ? "ON" : "OFF"}.\n` +
            (enabled
              ? "opt out anytime: `wbhk telemetry off` (or set WBHK_TELEMETRY=0 / DO_NOT_TRACK=1).\n"
              : "enable with `wbhk telemetry on`.\n"),
    );
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "show whether telemetry is on or off" },
});

export const telemetryRoute = buildRouteMap({
  routes: { on: onCommand, off: offCommand, status: statusCommand },
  docs: { brief: "manage anonymous usage telemetry" },
});
