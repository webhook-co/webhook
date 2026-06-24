import { createHash } from "node:crypto";

import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

// A release as the GitHub /releases API returns it (trimmed to the fields the command reads).
const release = (tag: string, assetUrls: Record<string, string>) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: Object.entries(assetUrls).map(([name, browser_download_url]) => ({
    name,
    browser_download_url,
  })),
});

const ASSET_URL = "https://dl.test/wbhk-linux-x64";
const SUMS_URL = "https://dl.test/checksums.txt";
const NEW_BINARY = new TextEncoder().encode("the new wbhk 0.4.0 binary bytes");
const sha = createHash("sha256").update(NEW_BINARY).digest("hex");

// Fake fetch: the GitHub API returns the releases list; the asset/checksums URLs return their bodies.
function upgradeFetch(
  releases: unknown,
  bodies: Record<string, Uint8Array | string> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    const body = bodies[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function recordingReplace() {
  const calls: { path: string; data: Uint8Array }[] = [];
  return {
    calls,
    replace: async (path: string, data: Uint8Array): Promise<void> => {
      calls.push({ path, data });
    },
  };
}

const releasesWithUpdate = [
  release("web-v9.9.9", {}), // a non-CLI release in the monorepo — must be ignored
  release("cli-v0.4.0", { "wbhk-linux-x64": ASSET_URL, "checksums.txt": SUMS_URL }),
];
const goodSums = `${sha}  wbhk-linux-x64\n`;

describe("wbhk upgrade — standalone binary", () => {
  it("downloads, checksum-verifies, and atomically replaces the running binary", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      arch: "x64",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.path).toBe("/home/dev/.local/bin/wbhk");
    expect(Buffer.from(rec.calls[0]?.data as Uint8Array)).toEqual(Buffer.from(NEW_BINARY));
    expect(t.stdout()).toContain("upgraded wbhk 0.0.0 → 0.4.0");
  });

  it("verifies the binary's build provenance (by its sha256) before replacing", async () => {
    const rec = recordingReplace();
    const verified: string[] = [];
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: rec.replace,
      verifyBinaryProvenance: async ({ digestHex }) => {
        verified.push(digestHex);
      },
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(verified).toEqual([sha]); // verified the exact downloaded bytes' digest
    expect(rec.calls).toHaveLength(1); // and only then replaced
  });

  it("REFUSES to replace when provenance verification fails", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: rec.replace,
      verifyBinaryProvenance: async () => {
        throw new Error("no build provenance was found for this binary");
      },
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(rec.calls).toHaveLength(0); // never touched the binary
    expect(t.stderr().toLowerCase()).toContain("provenance");
  });

  it("--no-verify-provenance skips the provenance check (checksum only)", async () => {
    const rec = recordingReplace();
    let called = false;
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: rec.replace,
      verifyBinaryProvenance: async () => {
        called = true;
      },
    });
    await run(app, ["upgrade", "--no-verify-provenance"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(called).toBe(false); // verification was skipped
    expect(rec.calls).toHaveLength(1); // still installed
  });

  it("emits a structured result with --output json", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({
      action: "install",
      currentVersion: "0.0.0",
      latestVersion: "0.4.0",
      updateAvailable: true,
      installKind: "binary",
    });
  });

  it("REFUSES to replace the binary on a checksum mismatch", async () => {
    const rec = recordingReplace();
    const badSums = `${"0".repeat(64)}  wbhk-linux-x64\n`;
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: badSums }),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(rec.calls).toHaveLength(0); // never touched the binary
    expect(t.stderr().toLowerCase()).toContain("checksum");
  });

  it("REFUSES when the asset is absent from checksums.txt (fail closed)", async () => {
    const rec = recordingReplace();
    const sumsMissingAsset = `${sha}  wbhk-darwin-arm64\n`;
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, {
        [ASSET_URL]: NEW_BINARY,
        [SUMS_URL]: sumsMissingAsset,
      }),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(rec.calls).toHaveLength(0);
  });
});

describe("wbhk upgrade — non-install paths", () => {
  it("--check reports an available update without installing", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade", "--check"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls).toHaveLength(0);
    expect(t.stdout()).toContain("update available: 0.0.0 → 0.4.0");
  });

  it("defers an npm install to the package manager (no self-replace)", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/usr/local/bin/node", // running via node ⇒ the npm install
      fetch: upgradeFetch(releasesWithUpdate),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls).toHaveLength(0);
    expect(t.stdout()).toContain("npm install -g wbhk@latest");
  });

  it("reports no published release yet", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: upgradeFetch([release("web-v1.0.0", {})]), // no cli-v release
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls).toHaveLength(0);
    expect(t.stdout()).toContain("no published wbhk release yet");
  });

  it("reports unsupported when no prebuilt binary ships for this os/arch", async () => {
    const rec = recordingReplace();
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      arch: "ia32", // no asset
      fetch: upgradeFetch(releasesWithUpdate),
      replaceExecutable: rec.replace,
    });
    await run(app, ["upgrade"], t.ctx);
    expect(rec.calls).toHaveLength(0);
    expect(t.stdout().toLowerCase()).toContain("no prebuilt binary");
  });

  it("surfaces a failed binary replace (e.g. no write permission) as a clean error", async () => {
    const t = makeTestContext({
      execPath: "/usr/local/bin/wbhk",
      fetch: upgradeFetch(releasesWithUpdate, { [ASSET_URL]: NEW_BINARY, [SUMS_URL]: goodSums }),
      replaceExecutable: async () => {
        throw new Error("EACCES: permission denied, open '/usr/local/bin/wbhk'");
      },
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(t.stderr().toLowerCase()).toContain("could not replace");
  });

  it("surfaces a GitHub API failure as a clean error", async () => {
    const t = makeTestContext({
      execPath: "/home/dev/.local/bin/wbhk",
      fetch: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      replaceExecutable: async () => {},
    });
    await run(app, ["upgrade"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(t.stderr().toLowerCase()).toContain("could not check for updates");
  });
});
