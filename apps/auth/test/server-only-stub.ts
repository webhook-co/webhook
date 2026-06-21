// Test-only stub for the `server-only` marker package. The real package throws when imported
// outside a server build (enforcing the client/server boundary in `next build`); under vitest
// we alias it to this no-op so server-only modules (e.g. the consent ticket resolver) are
// importable in jsdom. See vitest.config.ts.
export {};
