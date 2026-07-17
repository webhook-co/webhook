import { defineConfig } from "vitest/config";

// report.ts is pure over Uint8Array/string — no workerd pool needed. DecompressionStream is a Web standard
// and is present in Node's undici globals, so the `node` env exercises the same code path the Worker runs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
