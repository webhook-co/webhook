import { describe, expect, it } from "vitest";

// The Homebrew formula generator's pure core (the .mjs CLI wrapper only runs when invoked directly). A wrong
// URL or swapped platform here would ship a broken `brew install webhook-co/tap/wbhk`, so pin the shape.
import { buildFormula, parseChecksums } from "../scripts/gen-homebrew-formula.mjs";

const SUMS = new Map([
  ["wbhk-darwin-arm64", "a".repeat(64)],
  ["wbhk-darwin-x64", "b".repeat(64)],
  ["wbhk-linux-arm64", "c".repeat(64)],
  ["wbhk-linux-x64", "d".repeat(64)],
  ["wbhk-windows-x64.exe", "e".repeat(64)], // ignored — Homebrew is macOS + Linux only
]);

describe("parseChecksums", () => {
  it("parses sha256sum format into name → hex", () => {
    const m = parseChecksums(
      `${"a".repeat(64)}  wbhk-linux-x64\n${"b".repeat(64)}  checksums.txt\n`,
    );
    expect(m.get("wbhk-linux-x64")).toBe("a".repeat(64));
    expect(m.get("checksums.txt")).toBe("b".repeat(64));
  });

  it("handles the binary-mode `*` marker and lowercases the hex", () => {
    expect(parseChecksums(`${"A".repeat(64)} *wbhk-darwin-arm64\n`).get("wbhk-darwin-arm64")).toBe(
      "a".repeat(64),
    );
  });
});

describe("buildFormula", () => {
  const f = buildFormula("0.1.1", SUMS);

  it("sets the class, version, and license", () => {
    expect(f).toContain("class Wbhk < Formula");
    expect(f).toContain('version "0.1.1"');
    expect(f).toContain('license "Apache-2.0"');
  });

  it("emits a macOS arm + intel block and a Linux arm + intel block", () => {
    expect(f).toContain("on_macos do");
    expect(f).toContain("on_linux do");
    expect((f.match(/on_arm do/g) ?? []).length).toBe(2);
    expect((f.match(/on_intel do/g) ?? []).length).toBe(2);
  });

  it("pins each platform asset to the cli-v<version> release URL + its sha256", () => {
    const base = "https://github.com/webhook-co/webhook/releases/download/cli-v0.1.1";
    expect(f).toContain(`url "${base}/wbhk-darwin-arm64"`);
    expect(f).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(f).toContain(`url "${base}/wbhk-linux-x64"`);
    expect(f).toContain(`sha256 "${"d".repeat(64)}"`);
  });

  it("never references the windows binary (Homebrew is macOS + Linux only)", () => {
    expect(f).not.toContain("windows");
    expect(f).not.toContain("e".repeat(64));
  });

  it("installs the bare binary as `wbhk` and tests --version", () => {
    expect(f).toContain('bin.install Dir["wbhk-*"].first => "wbhk"');
    expect(f).toContain('shell_output("#{bin}/wbhk --version")');
  });

  it("throws when a required platform asset is missing", () => {
    const partial = new Map(SUMS);
    partial.delete("wbhk-linux-arm64");
    expect(() => buildFormula("0.1.1", partial)).toThrow(/wbhk-linux-arm64/);
  });

  it("throws without a version", () => {
    expect(() => buildFormula("", SUMS)).toThrow(/version/i);
  });

  it("rejects a version with unsafe characters (no Ruby-string break-out)", () => {
    expect(() => buildFormula('0.1.2"; system("x")', SUMS)).toThrow(/invalid version/i);
    expect(() => buildFormula("0.1.2 rm -rf", SUMS)).toThrow(/invalid version/i);
    // a normal prerelease/build version is still fine
    expect(() => buildFormula("1.2.3-rc.1", SUMS)).not.toThrow();
  });
});
