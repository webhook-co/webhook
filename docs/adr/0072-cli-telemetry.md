# ADR 0072 — anonymous opt-out CLI telemetry (distribution DIST-14)

- status: accepted (distribution Phase 5 — the last optional).
- date: 2026-06-25
- scope: client — `packages/cli/src/telemetry.ts` (+ test), `src/state/telemetry-store.ts` (+ test), a
  `telemetry` command, a `sendTelemetry` io seam, the `bin.ts` hook. collector — new `apps/telemetry` Worker
  (`webhook-telemetry`) on `telemetry.wbhk.my` → Cloudflare Analytics Engine; `deploy-telemetry.yml`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-14). The constitution's "cookieless ingestion on a
  separate apex (wbhk.my)".
- review severity: medium-high (privacy — collecting usage data). `/code-review` + `/security-review`.

## context

The founder asked for opt-out usage telemetry to learn which commands are used. The bar: **anonymous, minimal,
honestly disclosed, trivially opt-out, and it must never affect a command.**

## decision

1. **What's collected (anonymous + minimal).** Per command run: the cli version, OS + arch, the **command
   NAME** (a known command/subcommand label — `commandLabel` emits only allow-listed names, **never** a
   positional arg/value, so an endpoint id / event id can't leak), the outcome (ok|error) + exit code, and a
   **coarse duration bucket** (`<100ms`/`<1s`/…). NEVER: args/values, payloads, tokens, credentials, profile
   names, URLs, endpoint/event ids, cwd, IP-derived identity, or any persistent user id. The collector
   **re-validates** to only the known fields with capped lengths and drops anything else.

2. **Opt-out model (enabled by default), trivially disabled.** `WBHK_TELEMETRY=0` (an explicit value also
   force-ENABLES, overriding everything), the cross-tool `DO_NOT_TRACK=1`, a persisted `wbhk telemetry off`,
   and **any CI environment** all disable it. `wbhk telemetry on|off|status` manages + inspects it. A
   **one-time** privacy notice prints to stderr on the first enabled run (then a `noticed` flag is set).

3. **Never blocks or fails a command.** The send is a fire-and-forget POST with a 1.5 s abort timeout, all
   errors swallowed; `bin.ts` doesn't await it (the CLI sets `process.exitCode`, so the loop drains the POST
   before exit). The whole hook is wrapped so telemetry can't change a command's behavior or exit code. The
   completion engine (`__complete`) is skipped (TAB must be instant + silent).

4. **Collector = a cookieless Worker → Analytics Engine, on the separate apex.** `apps/telemetry` writes one
   Analytics Engine data point per valid event (no database, no PII, no cookies, no CORS) and always responds
   `204` (the CLI ignores the body; not distinguishing valid/invalid gives abusers no feedback). It lives on
   **`telemetry.wbhk.my`** — the constitution's cookieless ingestion apex, not a primary app subdomain.

5. **Testability.** The privacy-critical pieces are pure + unit-tested: `commandLabel` (never leaks args),
   `resolveTelemetryEnabled` (every opt-out path), the event shape, and the collector's `parseEvent` (bounded,
   drops extras). The send + the bin.ts hook are coverage-excluded wiring.

## consequences

- We learn command usage + platform mix from anonymous, bounded data, with a clear opt-out and a one-time
  notice — and telemetry can never slow or break a command. Analytics Engine is free-tier + SQL-queryable.
- The collector is one more public edge Worker (api/mcp/auth/www/web/get/telemetry), deployed by its own CD.
- **Founder follow-ups (documented):** a public privacy page if desired (the notice is self-contained — no URL
  to 404); edge rate-limiting on `telemetry.wbhk.my` if abuse appears (AE writes are cheap + bounded, so v1
  relies on the CF edge). The default-on posture is the founder's explicit call (opt-out, not opt-in).

## alternatives considered

- **Full OpenTelemetry / OTLP.** Rejected for v1 — heavyweight for a CLI; a tiny custom event + Analytics
  Engine is simpler and CF-native.
- **A database (D1 / Postgres) for events.** Rejected — Analytics Engine is the right tool for high-volume,
  aggregate, no-PII counters; no schema/migrations/retention to manage.
- **Opt-in.** The founder chose opt-out (with a clear notice + easy opt-out); recorded so it's a deliberate
  decision, not a default.
