import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { Pool } from "pg";

// Schema-generation config for `better-auth generate`. NOT the runtime auth Worker
// (that lands separately) — it exists so the generator emits the identity
// tables the migration includes: user / session / account / verification
// (core) + apikey (the @better-auth/api-key plugin, a standalone package since
// better-auth 1.5). Social login + magic link add no new tables.
//
// The generator runs via `pnpm dlx @better-auth/cli@latest` (see package.json) so the
// CLI never enters the tracked dependency tree — better-auth never auto-migrates prod;
// the emitted DDL is checked in and owned as a dbmate migration.
//
// The Pool selects the Postgres dialect; `generate` connects to introspect/diff.
//
// `emailAndPassword` is enabled here only because it changes NO
// emitted tables (user/session/account/verification are the same DDL with or without it)
// — it keeps the generated schema stable for the CI drift guard. The runtime auth scope is
// social login + magic link, NOT password auth; this divergence is intentional and left
// for the runtime auth Worker to resolve when it lands. This file is the
// schema-GENERATOR config only; it is never the runtime, so the divergence is harmless.
export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  }),
  emailAndPassword: { enabled: true },
  plugins: [apiKey()],
});
