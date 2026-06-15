# ADR 0009 — CLI foundation: zero-dep router, pluggable credential store, stable exit codes

- status: accepted
- date: 2026-06-15
- scope: `packages/cli`
- review severity: high

## context

`packages/cli` is the wedge's first client (phase 2) and open-core (Apache-2.0). It must be a
lean, auditable, scriptable binary that authenticates with an API key, mirrors the seven
`packages/contract` capabilities, and handles credentials under the same discipline as the rest
of the stack (peppered-hash at rest server-side, never logged in plaintext; the loggable-view
redaction boundary in `docs/threat-model.md`). ADR-0014 already settled *what* CLI login is —
`wbhk login` / paste-or-env-var, OS keychain when available else a `0600` file, tokens redacted
everywhere. This ADR settles *how* the CLI is built, because those are load-bearing engineering
decisions (a parser parses untrusted argv; a credential store touches secrets) that should be
recorded rather than rediscovered. Relates to ADR-0014 (first-credential bootstrap), ADR-0010
(auth — API key as bearer), ADR-0008 / ADR-0003 (credential hashing), ADR-0005 (closed replay
target), ADR-0001 (open-core licensing).

## decision

1. **Argument parsing / routing: `@stricli/core`** (Apache-2.0, zero runtime dependencies,
   type-safe, isolated-context dependency injection). Chosen over commander/yargs/oclif on three
   grounds that matter here: supply chain (one auditable, transitive-dep-free package in the
   user-facing binary — yargs-parser/minimist carry a prototype-pollution CVE lineage), an
   isolated `process`/context object that all I/O flows through (so every command is
   deterministically testable with a fake context and no global is touched), and clean embedding
   in a `bun build --compile` binary (pure TS, no native NAPI). A gate test asserts the parser
   does not pollute `Object.prototype` from a `--__proto__.x` injection — we verify, not assume.

2. **Credential storage: a pluggable credential-store seam** (the git-style
   external-credential-helper pattern — an interface the CLI speaks to over a tiny get/set/erase
   contract; no Docker, no containers). Backends resolve in precedence order:
   `WBHK_API_KEY` env var (read-only, never persisted — the CI/headless path) → external helper
   (deferred; lets an org plug in Vault/1Password/a cloud secret manager) → OS keychain via
   OS-CLI shell-out (deferred; shell-out, not native NAPI, so it embeds in the compiled binary) →
   a `0600` JSON file under `$XDG_CONFIG_HOME/webhook` (or `~/.config/webhook`). A
   `requireSecureStorage` policy (`WBHK_REQUIRE_SECURE_STORAGE`) makes a plaintext-file write
   fail with a typed error rather than silently degrade (the GitHub-CLI lesson). The file is read
   only if its permissions are `0600` (a group/other-readable file is refused, not silently
   trusted or tightened). **No DIY file encryption:** a wrap key derived from the same disk and
   readable by the same user is obfuscation, not a control — the real controls are the OS
   keystore, the env/helper paths, and `0600` permissions. Displayed credentials go through the
   shared `redactSecret` (`whk_****`).

3. **Output + exit codes:** an output-formatter seam (`text` | `json`, selected by a shared
   `--output` flag) so every command returns structured data renderable for humans or scripts —
   the same shape MCP/API return, keeping capability parity. Process exit codes are stable and
   distinct: `0` success, `1` unexpected, `2` usage, `64` not-implemented, and one code per
   `CAPABILITY_ERRORS` member so automation can branch on the specific failure. stricli's
   internal negative exit sentinels are normalized into this 0–255 scheme.

## consequences

- The binary stays lean and auditable; no capability is cut and the command surface is asserted
  against `CAPABILITIES` (a new capability fails the build until the CLI surfaces it).
- Commands are deterministically testable via the injected context — the whole suite runs in the
  `node` pool with no real process spawning and no filesystem mutation outside a tmpdir.
- Credentials are secure-by-default with an honest, policy-gated insecure fallback; enterprises
  extend storage through the helper seam without any change to command code.
- The OS-keychain and external-helper backends are additive increments behind the seam shipped
  here; until they land, dev workstations use the `0600` file and CI uses `WBHK_API_KEY`.
- Distribution as a standalone binary is via `bun build --compile` (a non-gating artifact);
  signing/provenance and npm-publish bundling are deferred to the release epic.
