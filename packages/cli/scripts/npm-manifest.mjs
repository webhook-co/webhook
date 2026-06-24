// The package.json for the PUBLISHED `wbhk` npm package. Generated at release time (npm-build.mjs) instead
// of publishing the internal @webhook-co/cli manifest: that one is `private` and depends on `@webhook-co/*`
// via `workspace:*`, which `npm install` can't resolve. We bundle everything into a single node-runnable
// dist/bin.js (no runtime deps), so the published manifest is self-contained. Kept as a pure function so the
// shape is unit-tested (npm-manifest.test.ts) — a wrong field here ships a broken or mis-published package.
export function buildNpmManifest(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("buildNpmManifest: a version is required (e.g. 0.3.0)");
  }
  return {
    name: "wbhk",
    version,
    description: "Capture, inspect, and replay webhooks from your terminal — the webhook.co CLI.",
    type: "module",
    bin: { wbhk: "./dist/bin.js" },
    // Single bundled entry + docs only — never the TS source, tests, or build scripts.
    files: ["dist", "README.md"],
    engines: { node: ">=20" },
    license: "Apache-2.0",
    homepage: "https://webhook.co",
    repository: {
      type: "git",
      url: "git+https://github.com/webhook-co/webhook.git",
      directory: "packages/cli",
    },
    bugs: { url: "https://github.com/webhook-co/webhook/issues" },
    keywords: [
      "webhook",
      "webhooks",
      "cli",
      "tunnel",
      "replay",
      "standard-webhooks",
      "wbhk",
      "webhook.co",
    ],
    // Unscoped public package + npm provenance (GitHub Actions OIDC). With provenance:true here, a plain
    // `npm publish` in CI emits the attestation — no extra flag needed.
    publishConfig: { access: "public", provenance: true },
  };
}
