// `pnpm seed` — put the rows in your local database that make the dashboard usable.
//
// A migrated database is empty, and an empty database is not a working install: `/dev-session` mints a
// session for a hard-coded principal, and since ADR-0116 every gated page re-reads membership, so without
// these rows the dashboard bounces you straight back to sign-in with the session it just handed you.
//
// The seeding itself lives in @webhook-co/db/seed, next to the primitives it composes. This file is only the
// command: resolve a connection, build the two clients and the two keys, run it, and say what happened.
//
// It is safe to re-run. That is a property of the seeder, not of this script — see seedDevWorld.

import { createClient, type Sql } from "@webhook-co/db/client";
import { DB_ROLES } from "@webhook-co/db";
import { createCredentialHasherFromBase64 } from "@webhook-co/db/credential";
import { seedDevWorld, DEV_PRINCIPAL } from "@webhook-co/db/seed";
import { importAuditKey } from "@webhook-co/shared";

// @ts-expect-error - a plain .mjs sibling; it has no type declarations and needs none.
import { assertLocalTarget, resolveSeedUrl } from "./seed-target.mjs";

/** Dev-only key material. Worthless anywhere real — these seed rows are not secrets. */
const DEV_PEPPER = Buffer.from("dev-only-credential-pepper-32by!").toString("base64");
const DEV_AUDIT_KEY = new Uint8Array(Buffer.from("dev-only-audit-chain-key-32bytes"));

/** Swap the role in a connection URL, keeping everything else. */
function asRole(url: string, role: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  // The local cluster authenticates with `trust`, so the password is ignored — but postgres.js and
  // Miniflare both want one present, so keep whatever is already there.
  return parsed.toString();
}

async function main(): Promise<void> {
  // Fail closed on anything that is not this machine BEFORE opening a connection. The seeder signs audit
  // rows with a published dev key, so a mis-pointed target is a data-integrity incident — see seed-target.
  const base = resolveSeedUrl(process.env);
  assertLocalTarget(base);

  // Two roles, deliberately, because that is the split production lives with: the identity `"user"` table
  // belongs to webhook_auth and is ungranted to webhook_app. Seeding as a superuser instead would work and
  // would hide the boundary — and hiding it is how local drifts from prod.
  const app: Sql = createClient(asRole(base, DB_ROLES.app), { max: 1 });
  const identity: Sql = createClient(asRole(base, DB_ROLES.auth), { max: 1 });

  try {
    const world = await seedDevWorld({
      app,
      identity,
      auditKey: await importAuditKey(DEV_AUDIT_KEY),
      hasher: createCredentialHasherFromBase64(DEV_PEPPER),
    });

    console.log("✅ seeded your local database\n");
    // Ids only — an email is personal data, and this output lands in terminals, scrollback and CI logs.
    console.log(`   user     ${world.users.dev.id}`);
    console.log(`   org      ${world.orgs.primary.name}  (owner)   ${world.orgs.primary.id}`);
    console.log(`   org      ${world.orgs.second.name}  (member)  ${world.orgs.second.id}`);
    for (const endpoint of world.endpoints) {
      console.log(`   endpoint ${endpoint.name}  ${endpoint.id}`);
    }
    console.log(`\n   Sign in locally:  open http://localhost:3000/dev-session`);
    console.log(`   That mints a session for ${DEV_PRINCIPAL.userId} in the first org above.`);
    console.log(`\n   Re-running this is a no-op — it never duplicates or overwrites.`);
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
    await identity.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ seed failed: ${message}`);
  // A refusal already explains itself, and the "point it elsewhere" hint below would directly contradict
  // it — telling someone to set the very variable we just refused is how a safety check gets worked around.
  if (!message.startsWith("refusing to seed")) {
    console.error(
      `\n   Is the local database up and migrated?\n` +
        `     pnpm dev:db      # starts it and runs the migrations\n` +
        `   Set DEV_DB if your local database is somewhere other than the default.`,
    );
  }
  process.exit(1);
});
