#!/usr/bin/env node
// p99 ingest benchmark load driver. Drives the deployed bench Worker through steady, burst, and
// cold-reconnect scenarios and aggregates p50/p95/p99/p99.9 of the in-Worker DB round-trip, the R2
// PUT (variant R), and the worker-internal total (the ACK-budget number) — plus this driver's own
// end-to-end ACK clock — then prints a markdown report + verdict.
//
// Variants: A–D are the DB-insert variants (keep-B / reject-C). **R** is the durable-before-ACK shape
// (R2 PUT + variant-B insert) — the gate for ADR-0013; run it with `BENCH_VARIANTS=R`.
//
// Usage:
//   BENCH_URL=https://webhook-bench.<acct>.workers.dev node apps/engine/bench/driver.mjs           # A–D
//   BENCH_URL=... BENCH_VARIANTS=R COLD_VARIANTS=R R_SIZE=5120 node apps/engine/bench/driver.mjs    # the R2 gate
// Tunables (env): STEADY_RPS, STEADY_SECS, BURST_CONC, BURST_ROUNDS, COLD_IDLE_MS, COLD_CONC,
//   COLD_VARIANTS (default "A,B"), BENCH_VARIANTS (default "A,B,C,D"), R_SIZE (variant-R body bytes,
//   default 5120). Defaults are short to keep the always-on Neon window (and cost) small.

const BASE = process.env.BENCH_URL;
if (!BASE) {
  console.error("ERROR: set BENCH_URL to the deployed bench Worker origin");
  process.exit(1);
}
const num = (k, d) => Number(process.env[k] ?? d);
const VARIANTS = (process.env.BENCH_VARIANTS ?? "A,B,C,D").split(",");
const COLD_VARIANTS = (process.env.COLD_VARIANTS ?? "A,B").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const sorted = (k) =>
    ok
      .map((r) => r[k])
      .filter((x) => typeof x === "number")
      .sort((a, b) => a - b);
  const q = (s) => ({ p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), p999: pct(s, 99.9) });
  return {
    n: results.length,
    ok: ok.length,
    errors: results.length - ok.length,
    ack: q(sorted("ackMs")),
    db: q(sorted("dbMs")),
    // r2 + worker total are present only for variant R. worker total (measured INSIDE the isolate)
    // is the ACK-budget number — it excludes this driver's own network latency to the edge.
    r2: q(sorted("r2Ms")),
    total: q(sorted("totalMs")),
  };
}

// Variant R sweeps a realistic body size (?size=, default 5 KB ~ the PRD avg payload); A-D don't.
const sizeQuery = (variant) => (variant === "R" ? `?size=${num("R_SIZE", 5120)}` : "");

async function oneRequest(variant) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/run/${variant}${sizeQuery(variant)}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    const n = (x) => (typeof x === "number" ? x : null);
    return {
      ackMs: performance.now() - t0,
      dbMs: n(body.dbMs),
      r2Ms: n(body.r2Ms),
      totalMs: n(body.totalMs),
      ok: res.ok && body.error === undefined,
    };
  } catch {
    return { ackMs: performance.now() - t0, dbMs: null, r2Ms: null, totalMs: null, ok: false };
  }
}

const burst = (variant, concurrency) =>
  Promise.all(Array.from({ length: concurrency }, () => oneRequest(variant)));

async function steady(variant, rps, seconds) {
  const out = [];
  const inflight = [];
  const intervalMs = 1000 / rps;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    inflight.push(oneRequest(variant).then((r) => out.push(r)));
    await sleep(intervalMs);
  }
  await Promise.all(inflight);
  return out;
}

const fmt = (q) =>
  `${q.p50?.toFixed(1)} / ${q.p95?.toFixed(1)} / ${q.p99?.toFixed(1)} / ${q.p999?.toFixed(1)}`;

async function main() {
  const t0 = Date.now();
  console.error(`[bench] target=${BASE} variants=${VARIANTS.join(",")}`);
  const data = {};
  for (const v of VARIANTS) {
    console.error(`[bench] ${v}: warmup`);
    await burst(v, 5);
    console.error(`[bench] ${v}: steady ${num("STEADY_RPS", 40)}rps x ${num("STEADY_SECS", 20)}s`);
    const st = await steady(v, num("STEADY_RPS", 40), num("STEADY_SECS", 20));
    console.error(`[bench] ${v}: burst ${num("BURST_CONC", 100)}x${num("BURST_ROUNDS", 3)}`);
    const rounds = [];
    for (let i = 0; i < num("BURST_ROUNDS", 3); i++)
      rounds.push(...(await burst(v, num("BURST_CONC", 100))));
    data[v] = { steady: st, burst: rounds };
  }
  // Cold-reconnect: idle long enough for Hyperdrive to drop idle pooled connections, then fire.
  // (Always-on Neon never scale-to-zeros, so this models reconnect cost, not compute spin-up.)
  const coldIdle = num("COLD_IDLE_MS", 90000);
  console.error(`[bench] cold: idle ${coldIdle}ms then burst (${COLD_VARIANTS.join(",")})`);
  await sleep(coldIdle);
  for (const v of COLD_VARIANTS) data[v].cold = await burst(v, num("COLD_CONC", 20));

  // ---- report ----
  const lines = [];
  lines.push(
    `# p99 ingest benchmark`,
    ``,
    `Target: \`${BASE}\` · duration ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    ``,
  );
  lines.push(`p50 / p95 / p99 / p99.9 (ms).`, ``);
  for (const scenario of ["steady", "burst", "cold"]) {
    lines.push(
      `## ${scenario}`,
      ``,
      `worker-total = the ACK-budget number (measured inside the isolate; excludes driver→edge latency).`,
      `R2 is present only for variant R.`,
      ``,
      `| variant | n | err | worker-total p50/95/99/99.9 | DB p50/95/99/99.9 | R2 p50/95/99/99.9 |`,
      `|---|---|---|---|---|---|`,
    );
    for (const v of VARIANTS) {
      const r = data[v][scenario];
      if (!r) continue;
      const s = summarize(r);
      lines.push(`| ${v} | ${s.n} | ${s.errors} | ${fmt(s.total)} | ${fmt(s.db)} | ${fmt(s.r2)} |`);
    }
    lines.push(``);
  }
  // Verdict. Optional-chain every lookup so a variant subset (custom BENCH_VARIANTS) degrades to
  // "NaN" in the verdict line rather than crashing report generation after a full load run.
  const dbP99 = (v, sc) => summarize(data[v]?.[sc] ?? []).db.p99;
  const bDeltaSteady = dbP99("B", "steady") - dbP99("A", "steady");
  const bColdAck = data.B?.cold ? summarize(data.B.cold).ack.p999 : NaN;
  const cBurstAck = summarize(data.C?.burst ?? []).ack.p99;
  const bBurstAck = summarize(data.B?.burst ?? []).ack.p99;
  lines.push(`## Verdict (acceptance)`, ``);
  lines.push(
    `- B p99 DB delta over A (steady): **${bDeltaSteady.toFixed(2)} ms** (expect sub-ms to low-ms).`,
  );
  lines.push(
    `- C vs B burst ACK p99: **${cBurstAck.toFixed(1)} vs ${bBurstAck.toFixed(1)} ms** (C should be worse — pinned connections).`,
  );
  lines.push(
    `- B cold+burst ACK p99.9: **${Number.isNaN(bColdAck) ? "n/a" : bColdAck.toFixed(1)} ms** vs Shopify ~5000 ms budget.`,
  );
  lines.push(
    ``,
    `_Keep B if its DB delta over A is small AND its cold/burst ACK p99.9 clears ~5 s with margin; formally reject C._`,
  );
  if (data.R) {
    const rBurst = summarize(data.R.burst ?? []).total.p999;
    const rCold = data.R.cold ? summarize(data.R.cold).total.p999 : NaN;
    lines.push(
      ``,
      `## Verdict (durable-before-ACK gate, variant R — ADR-0013)`,
      ``,
      `- R worst worker-total p99.9: burst **${Number.isNaN(rBurst) ? "n/a" : rBurst.toFixed(1)} ms** / cold **${Number.isNaN(rCold) ? "n/a" : rCold.toFixed(1)} ms** vs Shopify ~5000 ms budget.`,
      `- _Ship PUT-first synchronous durable-before-ACK if R's cold/burst worker-total p99.9 clears ~5 s with margin (the Postgres-staging fallback stays unbuilt)._`,
    );
  }

  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
