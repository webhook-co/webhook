import { describe, expect, it } from "vitest";

import { NotImplementedError } from "../errors.js";
import {
  formatCliError,
  formatUnknownCommand,
  redactCredential,
  renderJson,
  resolveFormat,
} from "./format.js";

describe("output/format", () => {
  it("resolveFormat prefers the explicit flag, else text", () => {
    expect(resolveFormat(undefined)).toBe("text");
    expect(resolveFormat("text")).toBe("text");
    expect(resolveFormat("json")).toBe("json");
  });

  it("renderJson is deterministic, pretty-printed JSON", () => {
    const out = renderJson({ b: 1, a: 2 });
    expect(out).toBe('{\n  "b": 1,\n  "a": 2\n}');
    expect(JSON.parse(out)).toEqual({ b: 1, a: 2 });
  });

  it("redactCredential never reveals the full secret (reuses shared redactSecret)", () => {
    const apiKey = "whk_super_secret_value_do_not_leak";
    const handle = redactCredential({ apiKey });
    expect(handle).toBe("whk_****");
    expect(handle).not.toContain("secret");
    expect(handle.length).toBeLessThan(apiKey.length);
  });

  it("formatCliError renders the voice-compliant user message, never a stack trace", () => {
    const line = formatCliError(new NotImplementedError(["login"], "slice 9"), { color: false });
    expect(line).toContain("isn't built yet");
    expect(line).toContain("slice 9");
    expect(line).not.toMatch(/\bat \//); // no stack frames
    expect(line.toLowerCase()).not.toContain("webhook.co".toUpperCase()); // brand stays lowercase
  });

  it("formatCliError falls back to a plain message for ordinary errors and non-errors", () => {
    expect(formatCliError(new Error("boom"), { color: false })).toBe("boom");
    expect(formatCliError("just a string", { color: false })).toBe("just a string");
  });
});

describe("formatUnknownCommand (did-you-mean)", () => {
  it("suggests the closest command when stricli offers a correction (already backtick-quoted)", () => {
    const line = formatUnknownCommand({ input: "evnts", corrections: ["`events`"] });
    expect(line).toContain("unknown command");
    expect(line).toContain("`evnts`");
    expect(line).toContain("did you mean `events`?"); // joined as-is, not double-wrapped
    expect(line).toContain("wbhk --help");
  });

  it("lists every offered correction", () => {
    const line = formatUnknownCommand({ input: "l", corrections: ["`list`", "`listen`"] });
    expect(line).toContain("`list`");
    expect(line).toContain("`listen`");
    expect(line).toContain("`list` or `listen`");
  });

  it("points at --help when there is no close match", () => {
    const line = formatUnknownCommand({ input: "wat", corrections: [] });
    expect(line).toContain("unknown command `wat`");
    expect(line).toContain("wbhk --help");
    expect(line).not.toContain("did you mean");
  });
});
