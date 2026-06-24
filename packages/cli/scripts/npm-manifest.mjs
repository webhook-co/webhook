// The package.json for the PUBLISHED npm package, generated at release time (npm-build.mjs) instead of
// publishing the internal @webhook-co/cli workspace manifest: that one is `private` and depends on
// `@webhook-co/*` via `workspace:*`, which `npm install` can't resolve. We bundle everything into a single
// node-runnable dist/bin.js (no runtime deps), so the published manifest is self-contained. Kept as a pure
// function so the shape is unit-tested (npm-manifest.test.ts) — a wrong field ships a broken/mis-published
// package.
//
// Published SCOPED as `@webhook-co/cli` (the command is still `wbhk` — see the `bin` below). npm's
// similarity guard refuses the unscoped `wbhk` ("too similar to 'walk'"), and scoping under the org sidesteps
// it. The `bin` path has NO leading `./` — npm strips/rejects `./`-prefixed bin entries on publish.
export function buildNpmManifest(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("buildNpmManifest: a version is required (e.g. 0.3.0)");
  }
  return {
    name: "@webhook-co/cli",
    version,
    description:
      "Capture, inspect, and replay webhooks from your terminal — the webhook.co CLI (wbhk).",
    type: "module",
    bin: { wbhk: "dist/bin.js" },
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
    // Scoped packages default to RESTRICTED — `access: public` makes it installable by anyone. + npm
    // provenance (GitHub Actions OIDC): with provenance:true a plain `npm publish` in CI emits the attestation.
    publishConfig: { access: "public", provenance: true },
  };
}
