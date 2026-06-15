import { describe, expect, it } from "vitest";

import { resolveConfigDir } from "./paths.js";

describe("resolveConfigDir", () => {
  it("uses $XDG_CONFIG_HOME when set", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/dev")).toBe("/xdg/webhook");
  });

  it("falls back to ~/.config when XDG is unset or blank", () => {
    expect(resolveConfigDir({}, "/home/dev")).toBe("/home/dev/.config/webhook");
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "  " }, "/home/dev")).toBe(
      "/home/dev/.config/webhook",
    );
  });
});
