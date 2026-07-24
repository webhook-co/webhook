import { defineConfig } from "tsup";

// WHY THIS REPLACED `tsc`: plain `tsc` emits the source's extensionless relative specifiers verbatim
// (`import … from "./scheme"`), which TypeScript resolves happily and Node's ESM loader does not —
// `ERR_MODULE_NOT_FOUND: …/dist/scheme`. That was invisible for as long as this package was private,
// because every consumer in this repo imports `src/` and bundles it. The moment it is published, that
// output is what a user installs, and it does not load.
//
// Same shape as the SDK's build for the same reason: dual ESM + CJS with bundled declarations, so the
// package is consumable from `import` and `require` graphs alike. No minification — a library ships
// readable, source-mapped code.
//
// `dts: true` still emits `dist/index.d.ts`, which apps/web and apps/auth pin in their tsconfig
// `paths`. Bundled declarations keep that path valid; the per-module `dist/*.d.ts` files that `tsc`
// used to scatter were never referenced.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: "es2022",
});
