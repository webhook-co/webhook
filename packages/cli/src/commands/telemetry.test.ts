import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { resolveConfigDir } from "../config/paths.js";
import { makeTestContext } from "../context.js";
import { readTelemetryState } from "../state/telemetry-store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wbhk-tele-cmd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("wbhk telemetry", () => {
  it("`off` persists disabled and `status` reflects it", async () => {
    const t1 = makeTestContext({ homedir: home, env: {} });
    await run(app, ["telemetry", "off"], t1.ctx);
    expect(t1.stdout()).toContain("disabled");
    expect(await readTelemetryState(resolveConfigDir({}, home))).toMatchObject({ enabled: false });

    const t2 = makeTestContext({ homedir: home, env: {} });
    await run(app, ["telemetry", "status"], t2.ctx);
    expect(t2.stdout()).toContain("OFF");
  });

  it("`on` persists enabled", async () => {
    const t = makeTestContext({ homedir: home, env: {} });
    await run(app, ["telemetry", "on"], t.ctx);
    expect(t.stdout()).toContain("enabled");
    expect(await readTelemetryState(resolveConfigDir({}, home))).toMatchObject({ enabled: true });
  });

  it("`status --output json` reports the resolved state (env override)", async () => {
    const t = makeTestContext({ homedir: home, env: { DO_NOT_TRACK: "1" } });
    await run(app, ["telemetry", "status", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toEqual({ enabled: false });
  });
});
