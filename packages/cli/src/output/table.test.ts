import { describe, expect, it } from "vitest";

import { colorize, stripAnsi } from "./color.js";
import { renderTable } from "./table.js";

describe("renderTable", () => {
  it("left-aligns columns with a two-space gutter and no trailing whitespace", () => {
    const out = renderTable(
      ["NAME", "STATUS"],
      [
        ["a", "active"],
        ["longer-name", "paused"],
      ],
    );
    const lines = out.split("\n");
    // The NAME column is as wide as the widest cell ("longer-name" = 11), then a 2-space gutter.
    expect(lines[0]).toBe("NAME         STATUS");
    expect(lines[1]).toBe("a            active");
    expect(lines[2]).toBe("longer-name  paused");
    expect(lines.every((l) => l === l.trimEnd())).toBe(true);
  });

  it("aligns by VISIBLE width so colored cells don't skew the columns", () => {
    const out = renderTable(
      ["STATUS", "ID"],
      [
        [colorize("active", "green", true), "x"],
        ["paused", "y"],
      ],
    );
    // After stripping color, every line's columns line up identically.
    const stripped = stripAnsi(out).split("\n");
    expect(stripped[0]).toBe("STATUS  ID");
    expect(stripped[1]).toBe("active  x");
    expect(stripped[2]).toBe("paused  y");
  });

  it("renders just the header row for an empty result set", () => {
    expect(renderTable(["NAME", "STATUS"], [])).toBe("NAME  STATUS");
  });
});
