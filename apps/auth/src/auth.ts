import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { Pool } from "pg";

// Schema-generation config for `better-auth generate`. NOT the runtime auth Worker
// (that's the auth workstream) — it exists so the generator emits the identity
// tables the freeze migration includes: user / session / account / verification
// (core) + apikey (the @better-auth/api-key plugin, which in better-auth 1.6.x is a
// standalone package, per ADR-0010). Social login + magic link add no new tables.
//
// The Pool selects the Postgres dialect; `generate` connects to introspect/diff.
export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  }),
  emailAndPassword: { enabled: true },
  plugins: [apiKey()],
});
