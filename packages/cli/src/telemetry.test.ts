import { describe, expect, it } from "vitest";

import {
  buildTelemetryEvent,
  commandLabel,
  durationBucket,
  resolveTelemetryEnabled,
} from "./telemetry.js";

describe("resolveTelemetryEnabled (opt-out model)", () => {
  const base = { env: {} as Record<string, string | undefined>, stored: undefined };

  it("is enabled by default", () => {
    expect(resolveTelemetryEnabled(base)).toBe(true);
  });

  it("WBHK_TELEMETRY=0/false/off/no disables", () => {
    for (const v of ["0", "false", "off", "no", "OFF"]) {
      expect(resolveTelemetryEnabled({ ...base, env: { WBHK_TELEMETRY: v } })).toBe(false);
    }
  });

  it("DO_NOT_TRACK disables (the cross-tool standard)", () => {
    expect(resolveTelemetryEnabled({ ...base, env: { DO_NOT_TRACK: "1" } })).toBe(false);
  });

  it("a stored `telemetry off` disables", () => {
    expect(resolveTelemetryEnabled({ ...base, stored: false })).toBe(false);
  });

  it("is auto-disabled in CI", () => {
    expect(resolveTelemetryEnabled({ ...base, env: { CI: "true" } })).toBe(false);
    expect(resolveTelemetryEnabled({ ...base, env: { GITHUB_ACTIONS: "true" } })).toBe(false);
  });

  it("an explicit WBHK_TELEMETRY=1 overrides CI / DO_NOT_TRACK / stored-off", () => {
    expect(
      resolveTelemetryEnabled({
        env: { WBHK_TELEMETRY: "1", CI: "true", DO_NOT_TRACK: "1" },
        stored: false,
      }),
    ).toBe(true);
  });
});

describe("commandLabel — never leaks args", () => {
  it("records a plain top-level command", () => {
    expect(commandLabel(["login"])).toBe("login");
    expect(commandLabel(["doctor", "--output", "json"])).toBe("doctor");
  });

  it("records a known subcommand for grouped commands", () => {
    expect(commandLabel(["events", "list", "--limit", "5"])).toBe("events list");
    expect(commandLabel(["telemetry", "off"])).toBe("telemetry off");
  });

  it("NEVER emits a positional arg as the command (an endpoint id / event id)", () => {
    // `listen <endpoint-id>` → just "listen"; the id is a positional arg, never recorded.
    expect(commandLabel(["listen", "0229c1fc-d8e5-8fdc-bbaf-01dcad8355ab"])).toBe("listen");
    // an unknown subcommand under a known group → just the group (the token isn't echoed).
    expect(commandLabel(["events", "ev_secret_id_12345"])).toBe("events");
    expect(commandLabel(["replay", "ev_secret_id", "--forward", "localhost:3000"])).toBe("replay");
  });

  it("maps an unknown command to a fixed label (not the raw token)", () => {
    expect(commandLabel(["definitely-not-a-command"])).toBe("other");
    expect(commandLabel(["--help"])).toBe("help");
    expect(commandLabel(["--version"])).toBe("version");
    expect(commandLabel([])).toBe("none");
  });
});

describe("durationBucket (coarse, never precise)", () => {
  it("buckets into coarse ranges", () => {
    expect(durationBucket(40)).toBe("<100ms");
    expect(durationBucket(450)).toBe("<1s");
    expect(durationBucket(5000)).toBe("<10s");
    expect(durationBucket(42_000)).toBe("<1m");
    expect(durationBucket(120_000)).toBe(">=1m");
  });
});

describe("buildTelemetryEvent", () => {
  it("assembles an anonymous event (no args, bucketed duration)", () => {
    const e = buildTelemetryEvent({
      version: "0.1.2",
      platform: "darwin",
      arch: "arm64",
      argv: ["events", "get", "ev_secret_id"],
      exitCode: 0,
      durationMs: 320,
    });
    expect(e).toEqual({
      v: "0.1.2",
      os: "darwin",
      arch: "arm64",
      command: "events get",
      outcome: "ok",
      exit: 0,
      duration: "<1s",
    });
    // the secret event id never appears anywhere in the payload
    expect(JSON.stringify(e)).not.toContain("ev_secret_id");
  });

  it("marks a non-zero exit as an error outcome", () => {
    const e = buildTelemetryEvent({
      version: "0.1.2",
      platform: "linux",
      arch: "x64",
      argv: ["listen", "ep-id"],
      exitCode: 16,
      durationMs: 90_000,
    });
    expect(e.outcome).toBe("error");
    expect(e.exit).toBe(16);
    expect(e.command).toBe("listen");
    expect(e.duration).toBe(">=1m");
  });
});
