import { defineConfig } from "vitest/config";

// heartbeat.ts / canary.ts are pure functions over injected stores and clocks — no Worker bindings
// and no Durable Objects — so their tests run in the plain `node` env rather than the workerd pool.
// The Worker entry is thin wiring over these tested units.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
