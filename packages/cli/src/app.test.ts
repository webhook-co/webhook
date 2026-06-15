import { run } from "@stricli/core";
import { CAPABILITIES } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { app, CAPABILITY_COMMANDS, VERSION } from "./app.js";
import { makeTestContext } from "./context.js";
import { EXIT, normalizeStricliExitCode } from "./output/exit-codes.js";

// Walk the stricli route tree by path. A RouteMap exposes getRoutingTargetForInput;
// a Command does not. Returns the resolved target, or undefined if the path is invalid.
function resolveRoute(path: readonly string[]): unknown {
  let target: unknown = app.root;
  for (const segment of path) {
    if (
      !target ||
      typeof (target as { getRoutingTargetForInput?: unknown }).getRoutingTargetForInput !==
        "function"
    ) {
      return undefined;
    }
    target = (
      target as { getRoutingTargetForInput: (s: string) => unknown }
    ).getRoutingTargetForInput(segment);
  }
  return target;
}
function isCommand(target: unknown): boolean {
  return (
    !!target &&
    typeof (target as { getRoutingTargetForInput?: unknown }).getRoutingTargetForInput !==
      "function" &&
    "loader" in (target as object)
  );
}

describe("CLI command surface ↔ capability parity", () => {
  it("maps every contract capability to a registered CLI command", () => {
    for (const cap of CAPABILITIES) {
      const path = CAPABILITY_COMMANDS[cap.name];
      expect(path, `capability ${cap.name} has no CLI command mapping`).toBeDefined();
      expect(
        isCommand(resolveRoute(path!)),
        `command for ${cap.name} (${path?.join(" ")}) is not registered`,
      ).toBe(true);
    }
  });

  it("maps exactly the contract capabilities — no stale entries", () => {
    const capNames = new Set(CAPABILITIES.map((c) => c.name));
    for (const mapped of Object.keys(CAPABILITY_COMMANDS)) {
      expect(capNames.has(mapped), `${mapped} is mapped but is not a contract capability`).toBe(
        true,
      );
    }
  });
});

describe("CLI app behavior", () => {
  it("prints the version", async () => {
    const t = makeTestContext();
    await run(app, ["--version"], t.ctx);
    expect(t.stdout()).toContain(VERSION);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
  });

  it("treats an unknown command as a usage error", async () => {
    const t = makeTestContext();
    await run(app, ["definitely-not-a-command"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });

  it("runs a not-yet-built command as a clear, non-zero stub", async () => {
    const t = makeTestContext();
    await run(app, ["endpoints", "list"], t.ctx);
    expect(t.stderr().toLowerCase()).toContain("isn't built yet");
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.NOT_IMPLEMENTED);
  });

  it("wires the real `login` command (no key + non-interactive → a usage error, not a stub)", async () => {
    const t = makeTestContext(); // no WBHK_API_KEY, not a TTY, no --stdin
    await run(app, ["login"], t.ctx);
    expect(t.stderr().toLowerCase()).toContain("no api key provided");
    expect(t.stderr().toLowerCase()).not.toContain("isn't built yet");
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });

  it("accepts the shared --output flag on capability commands", async () => {
    const t = makeTestContext();
    await run(app, ["endpoints", "list", "--output", "json"], t.ctx);
    // recognized flag → falls through to the stub, not a usage error
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.NOT_IMPLEMENTED);
  });

  it("does not pollute Object.prototype from a __proto__ flag injection", async () => {
    const t = makeTestContext();
    await run(app, ["endpoints", "list", "--__proto__.polluted", "x"], t.ctx);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
