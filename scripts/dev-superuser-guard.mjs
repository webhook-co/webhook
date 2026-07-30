#!/usr/bin/env node
// No local Hyperdrive binding may connect as a database SUPERUSER.
//
// A superuser bypasses row-level security unconditionally. So a query production would REFUSE — reading
// another tenant's endpoints, say — succeeds locally, and succeeds in CI. Tenant isolation is precisely
// what this schema's RLS policies exist to enforce, and a superuser binding is the one gap that lets a
// violation through every gate we have.
//
// The direction of the failure is what makes it worth a guard. A missing service binding fails LOUDLY at
// call time; you find it immediately. A superuser binding fails SILENTLY, by permitting something it
// should not, so nothing ever draws attention to it. The bug surfaces in production, on real tenants.
//
// The roles themselves already exist: migration 0002 creates `webhook_app`, `webhook_authn` and the rest
// as `login nosuperuser nobypassrls`, and scripts/dev-db.sh verifies every role the bindings ask for.
// Nothing here provisions anything — it only refuses to let a binding ask for the wrong one.
//
// Run: node scripts/dev-superuser-guard.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LOCAL_HOSTS } from "./dev-db-config.mjs";

const APPS_DIR = resolve(import.meta.dirname, "..", "apps");

/**
 * Roles that bypass RLS. `postgres` is the cluster bootstrap superuser; the others are the conventional
 * names a managed provider hands out. `webhook_owner` is NOT here: it owns the schema and runs migrations
 * (as it does in production) but is not a superuser and does not bypass RLS.
 */
export const SUPERUSER_ROLES = Object.freeze(
  new Set(["postgres", "root", "rdsadmin", "cloudsqlsuperuser"]),
);

/** Pull `{binding, localConnectionString}` pairs out of a JSONC config without needing it to parse. */
function bindingsIn(app, text) {
  const out = [];
  // Hyperdrive entries carry both keys in one object; the order between them is not guaranteed.
  const objects = text.match(/\{[^{}]*"localConnectionString"[^{}]*\}/g) ?? [];
  for (const obj of objects) {
    const binding = /"binding"\s*:\s*"([^"]+)"/.exec(obj)?.[1];
    const conn = /"localConnectionString"\s*:\s*"([^"]+)"/.exec(obj)?.[1];
    if (!binding || !conn) continue;
    let url;
    try {
      url = new URL(conn);
    } catch {
      continue; // not a URL we can judge; dev-db-config validates shape separately
    }
    if (!LOCAL_HOSTS.has(url.hostname)) continue; // a hosted DB is not ours to police
    out.push({ app, binding, role: decodeURIComponent(url.username) });
  }
  return out;
}

/** Every local Hyperdrive binding across every app — DISCOVERED, never hand-listed. */
function discover() {
  const found = [];
  for (const app of readdirSync(APPS_DIR).sort()) {
    const path = join(APPS_DIR, app, "wrangler.jsonc");
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    found.push(...bindingsIn(app, readFileSync(path, "utf8")));
  }
  return found;
}

export const LOCAL_BINDINGS = discover();

/**
 * The bindings that connect as a superuser.
 *
 * Pure and exported so the tests can drive it directly: a guard whose failing path is never exercised can
 * pass by construction, and refusing is this one's entire job.
 */
export function superuserBindings(bindings = LOCAL_BINDINGS) {
  return bindings.filter((b) => SUPERUSER_ROLES.has(b.role));
}

function run() {
  if (LOCAL_BINDINGS.length === 0) {
    console.error(
      "dev-superuser-guard: found no local Hyperdrive bindings — refusing to pass vacuously.",
    );
    process.exit(1);
  }
  const bad = superuserBindings();
  if (bad.length > 0) {
    console.error(
      `\n${bad.length} local binding(s) connect as a database superuser, which bypasses row-level security:\n` +
        bad.map((b) => `  ${b.app}/${b.binding}  (as ${b.role})`).join("\n") +
        `\n\nA superuser makes a query production would REFUSE succeed locally and in CI, so a tenant-isolation\n` +
        `bug passes every gate. Point each binding at its least-privilege role (see the roles created in\n` +
        `packages/db/db/migrations/0002_extensions_and_app_roles.sql); scripts/dev-db.sh verifies whatever\n` +
        `the bindings ask for.\n`,
    );
    process.exit(1);
  }
  const roles = new Set(LOCAL_BINDINGS.map((b) => b.role));
  console.log(
    `✅ ${LOCAL_BINDINGS.length} local bindings across ${roles.size} least-privilege roles; none is a superuser`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
