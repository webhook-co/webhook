# ADR 0012 — CLI auth: the scope-free identity endpoint + secure key input

- status: accepted
- date: 2026-06-15
- scope: `packages/cli`, `apps/api`, `packages/contract`
- review severity: high

## context

Slice 9 builds the CLI's auth seam — `wbhk login` (capture + validate + store an API key) and
`wbhk whoami` (show the authenticated org + scopes). Two load-bearing decisions needed recording:
*how* the CLI validates a key and reads identity, and *how* it captures the key safely. The bearer
model (API key for CLI/API; ADR-0010) and the credential storage (`0600` file / env / keychain seam;
ADR-0009, ADR-0014) are already settled; this ADR records the surface those decisions imply. Relates
to ADR-0014 (login is the auth boundary, not a capability), ADR-0010 (bearer), ADR-0011 (the read
server `verifyBearer` seam), ADR-0009 (CLI foundation), ADR-0008/0003 (key hashing posture).

## decision

1. **A dedicated identity endpoint, `GET /v1/whoami` on `apps/api`** — authenticated but **scope-free**,
   returning the caller's own principal `{orgId, scopes, userId?}`. It is an **auth primitive, not a
   capability**: it has no scope, serves no privileged data, and is therefore outside the capability
   registry + parity gate (consistent with ADR-0014's "login/identity is not a capability"). Chosen
   over validating with `endpoints.list?limit=1` (the first sketch), which couples "is this key valid"
   to the `endpoints:read` scope *and* a non-empty org — an audit-only key, or a fresh org with no
   endpoints, would fail to "log in" or show its org. The contract gains `authenticateBearer` (the
   scope-free sibling of `authorizeBearer`: same 401-vs-5xx split, no scope step) and `AuthContextSchema`
   (the one wire shape the server emits and the CLI parses).

2. **Secure key input only.** `wbhk login` takes the key from `--stdin` (piped), the `WBHK_API_KEY`
   env var, or an interactive **hidden prompt** — never an argv flag/positional, because a secret in
   argv leaks into shell history and is visible to other users via `ps`. The key is **validated
   against the identity endpoint before anything is written**, so a bad key stores nothing. A key from
   `WBHK_API_KEY` is the headless, **never-persisted** path (the env already supplies it); only a
   piped/prompted key is written to the `0600` store. Every displayed key goes through `redactSecret`
   (`whk_****`); the plaintext is never printed or logged.

3. **The CLI API client maps HTTP status → the closed `CapabilityError` taxonomy → a stable exit
   code** (the inverse of `apps/api/http-status.ts`), surfacing a typed `ApiError` that extends
   `CliError` so the app's single error formatter + `determineExitCode` handle it like every other
   error. `fetch` is injected, so the client and every command are node-tested with no network.

## consequences

- Slice 10's read commands reuse this API client (the `whoami()` method is the first of several).
- A self-host / dev API is targeted via `--api-url` or `WBHK_API_URL`; **persisting a per-profile
  base URL is deferred** — the credential store exposes only the credential today, and surfacing the
  profile's `apiBaseUrl` would widen the store interface beyond this slice. The env/flag override
  covers the need until then.
- "not authenticated" maps to one exit code whether the key is absent locally (`NotLoggedInError`) or
  rejected by the server (`ApiError(UNAUTHORIZED)`), so automation branches on a single signal.
- **The interactive hidden-prompt masking is a human-UI checkpoint** (does it actually hide the typed
  key?). The command logic is tested via injected fakes; the real TTY shim (`io.ts`) is thin +
  coverage-excluded and must be eyeballed by a human before release.
