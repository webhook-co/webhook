#!/usr/bin/env node
// Fire a scheduled Worker locally: `pnpm cron <job>`.
//
// Cron-driven work was the one production behaviour with no local trigger at all. You could read the
// handler, and you could wait an hour, and that was it — so every cron was effectively untested locally,
// which is exactly the "ships in prod, not exercisable here" gap AGENTS.md forbids.
//
// `wrangler dev --test-scheduled` exposes `/__scheduled?cron=<expr>`, which invokes the Worker's real
// `scheduled()` handler with that cron string. No fake transport, no mode flag: the same entry point
// Cloudflare calls, reached over HTTP.
//
// ⚠️ THE HONEST LIMITATION, stated up front because it changes what you are testing: a cron expression is
// the unit Cloudflare schedules, NOT a job. `apps/engine` fans 14 jobs out of its hourly tick, so firing
// any one of them fires all 14. This tool resolves a job to its tick, fires that, and PRINTS what else the
// tick runs — rather than implying an isolation that does not exist. Use the job name to say what you are
// aiming at; read the list to know what you actually triggered.
//
// Run: node scripts/dev-cron.mjs <job>      ·      --list to see every job

import { DEV_APPS } from "./dev-ports.mjs";
import { TARGETS } from "./cron-dispatch-guard.mjs";

/** The cron expression Cloudflare fires for each cadence the dispatchers recognise. */
const CADENCE_EXPR = Object.freeze({
  cap: "*/5 * * * *", // the 5-minute tick: engine runs ONLY the cap producer on it
  hourly: "0 * * * *",
  always: "0 * * * *", // no cadence gate — the app's single tick
});

/**
 * Workers whose `scheduled()` does NOT fan out, so the app itself is the job. Derived from the committed
 * cron triggers rather than hand-listed, so a new scheduled Worker cannot be silently unreachable.
 */
const SINGLE_HANDLER = Object.freeze({
  auth: "0 * * * *",
  dmarc: "0 9 * * *",
  health: "*/5 * * * *",
});

/**
 * job name -> { app, expr, alsoRuns }
 *
 * Job names are the `beat` identifiers the dispatch guard already pins, so this cannot drift into a second
 * vocabulary: rename a beat and the guard fails first.
 */
export function jobRegistry(targets = TARGETS, single = SINGLE_HANDLER) {
  const jobs = new Map();
  for (const target of targets) {
    const app = target.label.replace(/^apps\//, "");
    for (const [fn, meta] of Object.entries(target.crons)) {
      const expr = CADENCE_EXPR[meta.cadence];
      if (!expr) throw new Error(`${app}/${fn}: unknown cadence ${JSON.stringify(meta.cadence)}`);
      jobs.set(meta.beat, { app, expr, fn });
    }
  }
  for (const [app, expr] of Object.entries(single)) jobs.set(app, { app, expr, fn: "scheduled" });
  // Annotate each job with the OTHER jobs its tick also runs — the thing a caller must not be surprised by.
  for (const [name, job] of jobs) {
    job.alsoRuns = [...jobs]
      .filter(([other, j]) => other !== name && j.app === job.app && j.expr === job.expr)
      .map(([other]) => other)
      .sort();
  }
  return jobs;
}

export const JOBS = jobRegistry();

/** The URL that fires a job's tick against its locally-running Worker. */
export function scheduledUrl(job, apps = DEV_APPS) {
  const spec = apps[job.app];
  if (!spec) throw new Error(`dev-cron: no dev port registered for app "${job.app}"`);
  return `http://127.0.0.1:${spec.port}/__scheduled?cron=${encodeURIComponent(job.expr)}`;
}

function list() {
  const byApp = new Map();
  for (const [name, job] of JOBS) {
    if (!byApp.has(job.app)) byApp.set(job.app, []);
    byApp.get(job.app).push([name, job]);
  }
  console.log("\nLocal cron jobs — `pnpm cron <job>`\n");
  for (const [app, entries] of [...byApp].sort()) {
    console.log(`  ${app}`);
    for (const [name, job] of entries.sort()) {
      const shared = job.alsoRuns.length;
      const note =
        shared > 0 ? `  (its tick also runs ${shared} other job${shared > 1 ? "s" : ""})` : "";
      console.log(`    ${name.padEnd(28)} ${job.expr}${note}`);
    }
  }
  console.log(
    "\n  A cron EXPRESSION is what Cloudflare schedules, not a job — firing one job fires its",
  );
  console.log("  whole tick. The command prints exactly what it triggered.\n");
}

async function run() {
  const name = process.argv[2];
  if (!name || name === "--list" || name === "-l") {
    list();
    process.exit(name ? 0 : 1);
  }
  const job = JOBS.get(name);
  if (!job) {
    console.error(
      `\nUnknown cron job ${JSON.stringify(name)}. Run \`pnpm cron --list\` to see them all.\n`,
    );
    process.exit(1);
  }
  const url = scheduledUrl(job);
  console.log(`\n⏰ ${name} — firing ${job.app}'s "${job.expr}" tick`);
  if (job.alsoRuns.length > 0) {
    console.log(`   that tick ALSO runs: ${job.alsoRuns.join(", ")}`);
  }
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(
      `\n✖ could not reach ${job.app} on 127.0.0.1:${DEV_APPS[job.app].port}.\n` +
        `  Start the stack first (\`pnpm dev\`) — the scheduled endpoint only exists under ` +
        `\`wrangler dev --test-scheduled\`.\n  (${err.message})\n`,
    );
    process.exit(1);
  }
  const body = (await res.text()).trim();
  if (!res.ok) {
    console.error(`\n✖ ${job.app} returned HTTP ${res.status}${body ? `: ${body}` : ""}\n`);
    process.exit(1);
  }
  console.log(`   ✅ HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  console.log(`   Effects land in the Worker's own log, not here.\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await run();
}
