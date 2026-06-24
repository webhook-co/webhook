import { defineConfig } from "vitest/config";

// router.ts is a pure function over Web-standard URL + Response (no Worker bindings, no Durable Objects),
// so its tests run in the plain `node` env — no need for the workerd pool. The Worker entry (index.ts) is
// thin wiring that imports install.sh as a Text module + delegates to the tested router.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
