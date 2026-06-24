import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assetName,
  detectInstallKind,
  findAssetUrl,
  isUpgradeAvailable,
  managedUpgradeHint,
  planUpgrade,
  selectLatestCliRelease,
  tagToVersion,
  verifyChecksum,
  type ReleaseSummary,
} from "./upgrade.js";

const release = (tag: string, assets: string[] = []): ReleaseSummary => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map((name) => ({ name, browser_download_url: `https://x.test/${name}` })),
});

describe("assetName", () => {
  it("maps the supported os/arch pairs to the published asset names", () => {
    expect(assetName("darwin", "arm64")).toBe("wbhk-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("wbhk-darwin-x64");
    expect(assetName("linux", "x64")).toBe("wbhk-linux-x64");
    expect(assetName("linux", "arm64")).toBe("wbhk-linux-arm64");
    expect(assetName("win32", "x64")).toBe("wbhk-windows-x64.exe");
  });

  it("maps Windows arm64 to the x64 build (runs under emulation; no native arm64 build ships)", () => {
    expect(assetName("win32", "arm64")).toBe("wbhk-windows-x64.exe");
  });

  it("returns null for an unsupported os/arch (no prebuilt binary)", () => {
    expect(assetName("linux", "ia32")).toBeNull();
    expect(assetName("freebsd", "x64")).toBeNull();
  });
});

describe("detectInstallKind", () => {
  it("treats a node/bun runtime execPath as the npm (or dev) install", () => {
    expect(detectInstallKind("/usr/local/bin/node")).toBe("npm");
    expect(detectInstallKind("/opt/homebrew/bin/bun")).toBe("npm");
    expect(detectInstallKind("C:\\Program Files\\nodejs\\node.exe")).toBe("npm");
  });

  it("detects a Homebrew Cellar binary", () => {
    expect(detectInstallKind("/opt/homebrew/Cellar/wbhk/0.3.0/bin/wbhk")).toBe("homebrew");
  });

  it("detects a Scoop shim on Windows", () => {
    expect(detectInstallKind("C:\\Users\\dev\\scoop\\apps\\wbhk\\current\\wbhk.exe")).toBe("scoop");
  });

  it("treats a standalone compiled binary as self-upgradeable", () => {
    expect(detectInstallKind("/home/dev/.local/bin/wbhk")).toBe("binary");
    expect(detectInstallKind("/Users/dev/.local/bin/wbhk")).toBe("binary");
  });
});

describe("isUpgradeAvailable", () => {
  it("is true when the latest version is strictly greater", () => {
    expect(isUpgradeAvailable("0.3.0", "0.3.1")).toBe(true);
    expect(isUpgradeAvailable("0.3.0", "0.4.0")).toBe(true);
    expect(isUpgradeAvailable("0.3.0", "1.0.0")).toBe(true);
  });

  it("is false when already current or ahead", () => {
    expect(isUpgradeAvailable("0.3.0", "0.3.0")).toBe(false);
    expect(isUpgradeAvailable("0.4.0", "0.3.9")).toBe(false);
  });

  it("treats a dev build (0.0.0) as upgradeable to any real release", () => {
    expect(isUpgradeAvailable("0.0.0", "0.3.0")).toBe(true);
  });
});

describe("tagToVersion", () => {
  it("strips the cli-v prefix", () => {
    expect(tagToVersion("cli-v0.3.0")).toBe("0.3.0");
    expect(tagToVersion("cli-v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  it("rejects a non-cli tag", () => {
    expect(() => tagToVersion("v0.3.0")).toThrow();
    expect(() => tagToVersion("web-v0.3.0")).toThrow();
  });
});

describe("selectLatestCliRelease", () => {
  const rel = (tag: string, over: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [],
    ...over,
  });

  it("picks the newest non-draft, non-prerelease cli-v release (list is newest-first)", () => {
    const picked = selectLatestCliRelease([
      rel("web-v9.9.9"), // not a CLI release
      rel("cli-v0.4.0"), // newest CLI
      rel("cli-v0.3.0"),
    ]);
    expect(picked?.tag_name).toBe("cli-v0.4.0");
  });

  it("skips drafts and prereleases", () => {
    const picked = selectLatestCliRelease([
      rel("cli-v0.5.0", { draft: true }),
      rel("cli-v0.4.1", { prerelease: true }),
      rel("cli-v0.4.0"),
    ]);
    expect(picked?.tag_name).toBe("cli-v0.4.0");
  });

  it("returns null when there is no published CLI release", () => {
    expect(
      selectLatestCliRelease([rel("web-v1.0.0"), rel("cli-v0.1.0", { draft: true })]),
    ).toBeNull();
  });
});

describe("findAssetUrl", () => {
  const release: ReleaseSummary = {
    tag_name: "cli-v0.3.0",
    draft: false,
    prerelease: false,
    assets: [
      { name: "wbhk-linux-x64", browser_download_url: "https://example.test/wbhk-linux-x64" },
      { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
    ],
  };

  it("returns the download URL for a named asset", () => {
    expect(findAssetUrl(release, "wbhk-linux-x64")).toBe("https://example.test/wbhk-linux-x64");
  });

  it("throws when the asset is missing from the release", () => {
    expect(() => findAssetUrl(release, "wbhk-darwin-arm64")).toThrow(/wbhk-darwin-arm64/);
  });
});

describe("verifyChecksum", () => {
  const data = new TextEncoder().encode("the binary bytes");
  const good = createHash("sha256").update(data).digest("hex");

  it("passes when the checksum line matches", () => {
    const checksums = `${good}  wbhk-linux-x64\n`;
    expect(() => verifyChecksum(data, checksums, "wbhk-linux-x64")).not.toThrow();
  });

  it("fails CLOSED when the asset has no line in checksums.txt", () => {
    const checksums = `${good}  wbhk-darwin-arm64\n`; // a different asset
    expect(() => verifyChecksum(data, checksums, "wbhk-linux-x64")).toThrow(/checksum/i);
  });

  it("fails on a hash mismatch", () => {
    const wrong = "0".repeat(64);
    const checksums = `${wrong}  wbhk-linux-x64\n`;
    expect(() => verifyChecksum(data, checksums, "wbhk-linux-x64")).toThrow(/checksum/i);
  });
});

describe("managedUpgradeHint", () => {
  it("gives the right package-manager command per install kind", () => {
    expect(managedUpgradeHint("npm")).toMatch(/npm/);
    expect(managedUpgradeHint("homebrew")).toMatch(/brew/);
    expect(managedUpgradeHint("scoop")).toMatch(/scoop/);
  });
});

describe("planUpgrade", () => {
  const base = {
    current: "0.3.0",
    installKind: "binary" as const,
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    checkOnly: false,
  };

  it("reports no-release when there is no published CLI release", () => {
    expect(planUpgrade({ ...base, release: null })).toEqual({ action: "no-release" });
  });

  it("reports up-to-date when already current", () => {
    const plan = planUpgrade({ ...base, current: "0.4.0", release: release("cli-v0.3.0") });
    expect(plan).toMatchObject({ action: "up-to-date", current: "0.4.0", latest: "0.3.0" });
  });

  it("reports available (without installing) in check-only mode", () => {
    const plan = planUpgrade({
      ...base,
      checkOnly: true,
      release: release("cli-v0.4.0", ["wbhk-linux-x64", "checksums.txt"]),
    });
    expect(plan).toMatchObject({ action: "available", current: "0.3.0", latest: "0.4.0" });
  });

  it("defers a managed install to its package manager", () => {
    const plan = planUpgrade({
      ...base,
      installKind: "homebrew",
      release: release("cli-v0.4.0", ["wbhk-linux-x64"]),
    });
    expect(plan).toMatchObject({ action: "managed", kind: "homebrew", latest: "0.4.0" });
  });

  it("reports unsupported when no asset exists for this os/arch", () => {
    const plan = planUpgrade({
      ...base,
      arch: "ia32",
      release: release("cli-v0.4.0", ["wbhk-linux-x64"]),
    });
    expect(plan).toMatchObject({ action: "unsupported", platform: "linux", arch: "ia32" });
  });

  it("plans an install for a standalone binary with an available update", () => {
    const plan = planUpgrade({
      ...base,
      release: release("cli-v0.4.0", ["wbhk-linux-x64", "checksums.txt"]),
    });
    expect(plan).toMatchObject({
      action: "install",
      current: "0.3.0",
      latest: "0.4.0",
      assetName: "wbhk-linux-x64",
    });
  });

  it("check-only takes precedence over the install kind (never installs)", () => {
    const plan = planUpgrade({
      ...base,
      checkOnly: true,
      installKind: "binary",
      release: release("cli-v0.4.0", ["wbhk-linux-x64", "checksums.txt"]),
    });
    expect(plan.action).toBe("available");
  });
});
