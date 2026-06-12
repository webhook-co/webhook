import { describe, expect, it } from "vitest";

import { DB_PACKAGE } from "./index";

// Smoke test only. The real db suite (RLS leak tests, migration reversibility,
// the ingest_event + audit-trigger behavior) runs against a real Postgres in
// the rls-leak-tests step, under its own Postgres-backed CI job.
describe("@webhook-co/db", () => {
  it("exposes its package name", () => {
    expect(DB_PACKAGE).toBe("@webhook-co/db");
  });
});
