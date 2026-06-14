#!/usr/bin/env node
// WS-E benchmark load driver (wedge §0.2). Drives the deployed bench Worker through steady, burst,
// and cold-reconnect scenarios for the four variants and aggregates p50/p95/p99/p99.9 of end-to-end
// ACK (this driver's clock) AND the in-Worker DB round-trip (returned in the response), then prints a
// markdown report + the keep-B / reject-C verdict.
//
// Usage:
//   BENCH_URL=https://webhook-bench.<acct>.workers.dev node apps/engine/bench/driver.mjs
// Tunables (env): STEADY_RPS, STEADY_SECS, BURST_CONC, BURST_ROUNDS, COLD_IDLE_MS, COLD_CONC,
//   COLD_VARIANTS (default "A,B"), BENCH_VARIANTS (default "A,B,C,D"). Defaults are short to keep
//   the always-on Neon window (and cost) small.

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
  const ack = ok.map((r) => r.ackMs).sort((a, b) => a - b);
  const db = ok
    .map((r) => r.dbMs)
    .filter((x) => typeof x === "number")
    .sort((a, b) => a - b);
  const q = (s) => ({ p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), p999: pct(s, 99.9) });
  return {
    n: results.length,
    ok: ok.length,
    errors: results.length - ok.length,
    ack: q(ack),
    db: q(db),
  };
}

async function oneRequest(variant) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/run/${variant}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    const dbMs = typeof body.dbMs === "number" ? body.dbMs : null;
    return { ackMs: performance.now() - t0, dbMs, ok: res.ok && body.error === undefined };
  } catch {
    return { ackMs: performance.now() - t0, dbMs: null, ok: false };
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
    `# WS-E p99 ingest benchmark`,
    ``,
    `Target: \`${BASE}\` · duration ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    ``,
  );
  lines.push(`p50 / p95 / p99 / p99.9 (ms).`, ``);
  for (const scenario of ["steady", "burst", "cold"]) {
    lines.push(
      `## ${scenario}`,
      ``,
      `| variant | n | err | ACK p50/95/99/99.9 | DB p50/95/99/99.9 |`,
      `|---|---|---|---|---|`,
    );
    for (const v of VARIANTS) {
      const r = data[v][scenario];
      if (!r) continue;
      const s = summarize(r);
      lines.push(`| ${v} | ${s.n} | ${s.errors} | ${fmt(s.ack)} | ${fmt(s.db)} |`);
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
  lines.push(`## Verdict (acceptance, wedge §0.2)`, ``);
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

  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
