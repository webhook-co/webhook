import { describe, expect, it } from "vitest";

import { stripAnsi } from "./color.js";
import { parseAdvisoryHeader, renderAdvisoryNotice } from "./advisory-notice.js";

const update = {
  deprecated: false,
  current: "0.2.0",
  latest: "0.3.0",
  message: "ignored — the CLI renders its own",
};
const deprecated = { ...update, deprecated: true, current: "0.1.0" };

describe("renderAdvisoryNotice", () => {
  it("shows the version jump and the one command that fixes it", () => {
    const plain = stripAnsi(renderAdvisoryNotice(update, false));
    expect(plain).toContain("0.2.0");
    expect(plain).toContain("0.3.0");
    expect(plain).toContain("wbhk upgrade");
  });

  it("says UPDATE for a merely-stale version and DEPRECATED for an unsupported one", () => {
    expect(stripAnsi(renderAdvisoryNotice(update, false)).toLowerCase()).toContain("update");
    const dep = stripAnsi(renderAdvisoryNotice(deprecated, false)).toLowerCase();
    expect(dep).toContain("no longer supported");
  });

  it("draws a box whose lines all share the same VISIBLE width (color must not break alignment)", () => {
    // The trap: ANSI codes have length but no width. Measuring the raw string would make a colored line
    // look longer and the box would come out ragged in a real terminal.
    const lines = renderAdvisoryNotice(update, true).split("\n").filter(Boolean);
    const widths = new Set(lines.map((l) => stripAnsi(l).length));
    expect(widths.size, `ragged box: widths ${[...widths].join(", ")}`).toBe(1);
  });

  it("emits NO ansi escapes when color is disabled (piped output, NO_COLOR)", () => {
    const notice = renderAdvisoryNotice(update, false);
    expect(notice).toBe(stripAnsi(notice));
  });

  it("emits ansi escapes when color is enabled", () => {
    const notice = renderAdvisoryNotice(update, true);
    expect(notice).not.toBe(stripAnsi(notice));
  });
});

describe("parseAdvisoryHeader", () => {
  it("parses an update advisory", () => {
    expect(parseAdvisoryHeader("update-available; current=0.2.0; latest=0.3.0", null)).toEqual({
      deprecated: false,
      current: "0.2.0",
      latest: "0.3.0",
      message: "",
    });
  });

  it("treats the `deprecated` kind — or a Deprecation: true header — as deprecated", () => {
    expect(parseAdvisoryHeader("deprecated; current=0.1.0; latest=0.3.0", null)?.deprecated).toBe(
      true,
    );
    // The kind says merely-stale but the server also sent Deprecation: true — believe the louder signal.
    expect(
      parseAdvisoryHeader("update-available; current=0.1.0; latest=0.3.0", "true")?.deprecated,
    ).toBe(true);
  });

  // The server is not the CLI's parser: a garbled header must never break a command.
  it("returns null for absent or malformed input instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "garbage",
      "update-available",
      "update-available; current=; latest=",
    ]) {
      expect(() => parseAdvisoryHeader(bad, null)).not.toThrow();
      expect(parseAdvisoryHeader(bad, null)).toBeNull();
    }
  });
});
