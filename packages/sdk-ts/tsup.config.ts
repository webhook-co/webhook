import { defineConfig } from "tsup";

// The library build: dual ESM + CJS with bundled type declarations, so the SDK is consumable from
// `import` and `require` graphs alike (Node 18+, bundlers, Deno, browsers, Workers). No minification —
// a library ships readable, source-mapped code. Only `dist/` is published (see package.json `files`).
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
