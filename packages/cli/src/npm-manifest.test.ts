import { describe, expect, it } from "vitest";

// The npm package.json is GENERATED at release time (scripts/npm-build.mjs) rather than published from the
// internal @webhook-co/cli manifest — the workspace package is private and carries `workspace:*` deps that
// would break `npm install`. These tests pin the published shape so a regression can't ship a broken or
// unintentionally-public-with-the-wrong-fields package. The SUT is a plain .mjs (build tooling, not runtime
// CLI code) so it's importable here without compilation and stays out of the runtime coverage surface.
import { buildNpmManifest } from "../scripts/npm-manifest.mjs";

describe("buildNpmManifest", () => {
  it("publishes as the scoped `@webhook-co/cli` package at the given version", () => {
    const m = buildNpmManifest("1.2.3");
    // Scoped under the org: npm's similarity guard refuses the unscoped `wbhk`.
    expect(m.name).toBe("@webhook-co/cli");
    expect(m.version).toBe("1.2.3");
  });

  it("exposes the `wbhk` bin (no leading ./ — npm rejects that on publish)", () => {
    expect(buildNpmManifest("1.2.3").bin).toEqual({ wbhk: "dist/bin.js" });
  });

  it("is an ESM package that requires Node >= 22 (the bundled sigstore verifier's floor)", () => {
    const m = buildNpmManifest("1.2.3");
    expect(m.type).toBe("module");
    expect(m.engines?.node).toBe(">=22");
  });

  it("is NOT private (a private manifest refuses to publish)", () => {
    expect("private" in buildNpmManifest("1.2.3")).toBe(false);
  });

  it("declares NO dependencies — everything is bundled into dist/bin.js", () => {
    const m = buildNpmManifest("1.2.3");
    expect("dependencies" in m).toBe(false);
    expect("devDependencies" in m).toBe(false);
  });

  it("never leaks a workspace: protocol dep (which would break `npm install`)", () => {
    expect(JSON.stringify(buildNpmManifest("1.2.3"))).not.toContain("workspace:");
  });

  it("ships only the build output + docs", () => {
    const m = buildNpmManifest("1.2.3");
    expect(m.files).toContain("dist");
    expect(m.files).toContain("README.md");
    // Never ship the TS source / tests.
    expect(m.files).not.toContain("src");
  });

  it("is Apache-2.0, matching the open-core license", () => {
    expect(buildNpmManifest("1.2.3").license).toBe("Apache-2.0");
  });

  it("points provenance at the source repository", () => {
    // npm provenance requires a `repository` URL; without it `npm publish --provenance` fails.
    const m = buildNpmManifest("1.2.3");
    expect(m.repository?.url).toContain("github.com/webhook-co/webhook");
    expect(m.repository?.directory).toBe("packages/cli");
  });

  it("opts the published package into public access + provenance", () => {
    const m = buildNpmManifest("1.2.3");
    expect(m.publishConfig).toEqual({ access: "public", provenance: true });
  });

  it("refuses to build a manifest without a version", () => {
    // @ts-expect-error — exercising the runtime guard with a missing arg.
    expect(() => buildNpmManifest()).toThrow(/version/i);
    expect(() => buildNpmManifest("")).toThrow(/version/i);
  });
});
