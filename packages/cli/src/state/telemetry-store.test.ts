import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  markTelemetryNoticed,
  readTelemetryState,
  setTelemetryEnabled,
  telemetryStatePath,
} from "./telemetry-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wbhk-telemetry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("telemetry-store", () => {
  it("defaults to no override + not-noticed when nothing is stored", async () => {
    expect(await readTelemetryState(dir)).toEqual({ noticed: false });
  });

  it("persists the on/off choice (round-trip)", async () => {
    await setTelemetryEnabled(dir, false);
    expect(await readTelemetryState(dir)).toMatchObject({ enabled: false });
    await setTelemetryEnabled(dir, true);
    expect(await readTelemetryState(dir)).toMatchObject({ enabled: true });
  });

  it("records the one-time notice without clobbering the on/off choice", async () => {
    await setTelemetryEnabled(dir, false);
    await markTelemetryNoticed(dir);
    expect(await readTelemetryState(dir)).toEqual({ enabled: false, noticed: true });
  });

  it("treats a corrupt file as defaults (never throws)", async () => {
    writeFileSync(telemetryStatePath(dir), "{ not json");
    expect(await readTelemetryState(dir)).toEqual({ noticed: false });
  });

  it("ignores an unknown/old schema version", async () => {
    writeFileSync(telemetryStatePath(dir), JSON.stringify({ version: 99, enabled: false }));
    expect(await readTelemetryState(dir)).toEqual({ noticed: false });
  });
});
