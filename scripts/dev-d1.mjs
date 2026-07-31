#!/usr/bin/env node
// Apply every app's D1 migrations to the LOCAL database, so `pnpm dev` starts against a real schema.
//
// `pnpm dev` happily started apps/dmarc against a D1 database with no tables in it. `d1 migrations apply`
// existed only in `.github/workflows/deploy-dmarc.yml`, so production had the schema and no local machine
// ever did — nothing in `pnpm dev` or `pnpm dev:db` applied it, and nothing said so. It surfaced only when
// `pnpm cron dmarc` finally gave the cron a local trigger:
//
//     D1_ERROR: no such table: alert_state
//
// That is the shape AGENTS.md forbids: a capability that ships in prod and cannot be exercised here. The
// Postgres side already had `pnpm dev:db`; D1 simply had no equivalent because dmarc is the only user and
// nobody had run it.
//
// Discovered from the committed wrangler configs rather than a list of apps, so a second D1 user is covered
// the day it appears rather than the day someone remembers this file.
//
// Idempotent: wrangler keeps its own applied-migrations ledger, so re-running is a no-op. Run directly with
// `pnpm dev:d1`; `pnpm dev` runs it before starting anything.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The D1 databases a wrangler config declares, with the migrations directory for each.
 *
 * A database with no `migrations_dir` is skipped rather than guessed: applying migrations from an assumed
 * directory either fails confusingly or, worse, applies the wrong ones.
 */
export function discoverD1(text) {
  const out = [];
  const block = /"d1_databases"\s*:\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) return out;
  for (const entry of block[1].split("}")) {
    const name = /"database_name"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
    const dir = /"migrations_dir"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
    if (name && dir) out.push({ databaseName: name, migrationsDir: dir });
  }
  return out;
}

/** Every app in the repo that declares a D1 database with migrations. */
export function d1Apps(appsDir = resolve(REPO, "apps")) {
  const found = [];
  for (const app of readdirSync(appsDir)) {
    let text;
    try {
      text = readFileSync(resolve(appsDir, app, "wrangler.jsonc"), "utf8");
    } catch {
      continue; // not every app has a wrangler config
    }
    for (const db of discoverD1(text)) found.push({ app, ...db });
  }
  return found;
}

function run() {
  const apps = d1Apps();
  if (apps.length === 0) {
    console.log("dev-d1: no app declares a D1 database with migrations — nothing to do");
    return;
  }
  for (const { app, databaseName, migrationsDir } of apps) {
    const res = spawnSync(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", databaseName, "--local"],
      { cwd: resolve(REPO, "apps", app), encoding: "utf8" },
    );
    if (res.status !== 0) {
      console.error(
        `\n✖ dev-d1: could not apply ${app}'s D1 migrations (${databaseName}, ${migrationsDir}).\n` +
          `  Local dev would start against an EMPTY database and fail at the first query — which is how\n` +
          `  this was found (\`no such table: alert_state\`). Refusing to start rather than repeat that.\n` +
          `${res.stderr ?? ""}\n`,
      );
      process.exit(1);
    }
    // Say only what is true. Counting `.sql` occurrences in wrangler's output looked like a migration
    // count and was not — it renders each filename in both the plan and the result table, so three
    // migrations reported as twelve. A number nobody can act on is worse than no number.
    const nothingToDo = /No migrations to apply/i.test(res.stdout);
    console.log(`   ${app}: D1 ${databaseName} ${nothingToDo ? "already up to date" : "migrated"}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run();
}
