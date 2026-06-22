# ADR 0041 — `wbhk doctor` local diagnostics

- status: accepted (**D5** — local, silent diagnostics; self-contained, no auth surface).
- date: 2026-06-22
- scope: `packages/cli/src/commands/doctor.ts` (new — the checks + command), `packages/cli/src/api-client.ts`
  (`probeReachability` + `DOCTOR_PROBE_TIMEOUT_MS`), `packages/cli/src/config/paths.ts`
  (`resolveStateDir`/`resolveCacheDir`), `packages/cli/src/context.ts` (`homedir` + `platform` on
  `AppContext`), `packages/cli/src/version.ts` (new — single-sources `VERSION`; `app.ts` re-exports),
  `packages/cli/src/app.ts` (register `doctor`). Tests: `commands/doctor.test.ts` (new).
- relates: ADR-0009 (CLI foundation), ADR-0037/0039 (the global flags + profiles `doctor` reports), ADR-0036
  (the api-client this probes). `internal/build-plans/lane-d-cli.md` §D5. Lane D (`packages/cli`).
- review severity: medium (a new command + a context shape change + a network probe). One fresh-eyes code
  review (SHIP) + one security red-team (SHIP, no findings) — the code review's "unreachable → fail" MINOR
  was folded (now a warning).

## context

The CLI had no way to answer "why isn't this working?" — a user hitting an auth, config-permission,
connectivity, or clock problem had to guess. `doctor` is the one-shot local health check: it inspects what
the CLI can see (auth state, config health, terminal, paths) and does a single connectivity/clock probe,
then reports a clear pass/warn/fail per check. It is local-only and silent (no telemetry); the sole network
call is one unauthenticated reachability probe to the user's configured API origin.

## decision

1. **Checks are pure functions; the handler gathers.** Each check (`versionCheck`, `terminalCheck`,
   `credentialCheck`, `apiReachabilityCheck`, `clockCheck`, `configCheckFrom`, `pathsCheck`) is a pure
   function over already-gathered facts, returning `{ name, status: ok|warn|fail, detail }` — unit-tested in
   isolation. The command handler does the impure gathering (one `loadConfigFile`, one
   `probeReachability`, the store reads) and renders text (`✓`/`⚠`/`✗`, colorized) or the
   `{ checks, ok }` JSON envelope.

2. **Exit-code contract: FAIL = must-fix LOCAL misconfiguration only.** Exit 1 iff a check FAILS — and only
   a corrupt or world-readable config fails (problems the user must act on locally). Everything transient or
   external is a WARN that keeps exit 0: not-logged-in, clock skew, and an **unreachable API** (offline /
   captive wifi / a typo'd `--api-url` is not a broken install). So `doctor` is a friendly status, not a
   connectivity gate.

3. **`probeReachability` — one bounded, unauthenticated GET.** A 5 s `AbortSignal.timeout` GET to the
   validated base URL (via the existing https-only `resolveApiBaseUrl`); ANY HTTP response = reachable
   (even a 404 root), a transport error = unreachable; it never throws (bare catch), sends **no credential
   and no body**, and captures the `Date` response header for clock-skew. The skew check warns past 60 s
   (minted keys are time-bound — this pre-empts the auth failures D8 would otherwise hit).

4. **`homedir` + `platform` on `AppContext`; `version.ts` single-source.** `doctor` resolves the XDG
   config/state/cache dirs and runs the POSIX config-permission check, so the context now carries `homedir`
   + `platform` (both set in `buildContext`). `VERSION` moves to `version.ts` (app.ts re-exports it) to
   avoid an app↔doctor import cycle; the unstamped placeholder `0.0.0` is reported as `0.0.0 (dev)` until
   the distribution epic stamps it (Open-Q3).

## consequences

- `wbhk doctor` gives a user (or a CI job) an at-a-glance health read; `--output json` makes it scriptable.
- The XDG state/cache resolvers land here and are reused by D6's cross-run cursor store.
- The context now exposes `homedir`/`platform` for any future command that needs path/OS context.
- `doctor` exits non-zero only on a corrupt/insecure config — running it offline is a clean exit 0.

## alternatives considered

- **Unreachable API → fail (exit 1).** Rejected (code-review MINOR) — it punishes a transient/offline state
  the user can't fix locally; a warning surfaces it without making `doctor` a connectivity gate.
- **Authenticated probe (e.g. `/v1/whoami`).** Rejected for the reachability check — an unauthenticated GET
  to the origin answers "is it reachable + what's the server clock" without sending the credential or
  assuming a route; auth validity is already covered by the credential check + the real commands.
- **Stamp `(dev)` into `--version` too.** Deferred — `--version` keeps the raw `VERSION`; only `doctor`
  annotates `(dev)`, until the distribution epic stamps a real version.
