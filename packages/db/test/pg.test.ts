import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Verifies the Docker-free harness + the postgres.js client wiring against a real
// Postgres. The RLS leak suite (rls-leak-tests step) builds on this harness.
describe("ephemeral postgres harness", () => {
  let pg: EphemeralPostgres;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("starts a real postgres and answers queries through the client", async () => {
    const sql: Sql = createClient(pg.ownerUrl);
    try {
      const [one] = await sql<{ n: number }[]>`select 1 as n`;
      expect(one?.n).toBe(1);
      const [ver] = await sql<{ v: string }[]>`select version() as v`;
      expect(ver?.v).toContain("PostgreSQL");
    } finally {
      await sql.end();
    }
  });
});
