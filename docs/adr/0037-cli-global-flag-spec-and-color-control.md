# ADR 0037 — CLI shared global-flag spec + `--color`/`--no-color` control

- status: accepted (**D2a** — the global-flag FOUNDATION + color override of the output tier; the NDJSON
  `listen` formalisation, scriptable compact-list mode, and the documented exit-code map land in D2b).
- date: 2026-06-22
- scope: `packages/cli/src/global-flags.ts` (new — the shared `globalFlags` stricli spec + `GlobalFlags`
  type + `resolveGlobals`/`resolveColorFlag`), `packages/cli/src/commands/*.ts` (every command spreads
  `...globalFlags` and resolves via `resolveGlobals(this, flags)` instead of reading `ctx.colorEnabled`
  ad hoc), `packages/cli/src/commands/shared.ts` (`emitList` takes the resolved `color`). Tests:
  `src/global-flags.test.ts` (new), `src/commands/endpoints.test.ts` (+ an end-to-end `--color`/`--no-color`
  ANSI assertion).
- relates: ADR-0009 (CLI foundation), ADR-0036 (the D1a hygiene-tier retry logic; same output tier). Folds
  the plan's D0 (global-flag plumbing) into D2. `internal/build-plans/lane-d-cli.md` §D0/§D2. Lane D
  (`packages/cli`).
- review severity: medium (changes how every command resolves its flags; one fresh-eyes code review + one
  security red-team folded — both clean, no findings; the `--apiUrl` hoist is a verified no-op surface
  change, the value still flows through the `https`-only `resolveApiBaseUrl`).

## context

`@stricli/core` has **no built-in global flags**: flags are declared per-command and the parsed values are
handed to that command's handler. So a flag like `--output` had to be redeclared in every command's
`parameters.flags`, and the color decision was read straight off the context (`ctx.colorEnabled`, resolved
once in `buildContext` from `NO_COLOR`/TTY) with **no per-invocation override** — there was no `--color`
or `--no-color`. As the output tier (D2) and profiles (D3) add more cross-cutting flags, redeclaring each
one in nine command files drifts; and a user piping to a file (or a CI job) had no way to force color off
beyond setting `NO_COLOR`, nor to force it on when the TTY heuristic guesses wrong.

A subtlety the build had to get right: `buildContext(process)` runs **before** argv is parsed, so it can
resolve the *no-flag* layer (env/TTY color, the stored API base-URL) but can never see a flag value. The
"resolve globals once in the context" shape is therefore impossible — the merge of flag-over-env must
happen inside each handler, after stricli parses.

## decision

1. **A single shared `globalFlags` spec.** `packages/cli/src/global-flags.ts` exports one `as const`
   stricli flag-spec object — `output` (the `text`/`json` enum), `apiUrl` (the base-URL override, hoisted
   from the per-command duplicates), and `color` — plus a matching `GlobalFlags` type. Every command's
   `parameters.flags` is `{ ...globalFlags, <command-specific> }`, and a command interface `extends
   GlobalFlags`. A command that needs a tailored brief overrides one key after the spread
   (`{ ...globalFlags.output, brief: "…" }`), so the override wins while `kind`/`values`/`default` are
   inherited. One source of truth → shell completions and `--help` stay consistent, and D3's `--profile`
   bolts onto the same spec.

2. **`color` is one OPTIONAL boolean → `--color` AND `--no-color`.** stricli auto-generates the negation of
   a boolean flag, so a single `color?: boolean` surfaces as `--color` (force on) and `--no-color` (force
   off); unset stays `undefined`. (A second `noColor` flag was rejected — it collides with the
   auto-generated `--no-color`, which crashes `buildCommand`.)

3. **`resolveGlobals(ctx, flags)` at the top of each handler.** A small pure helper merges the parsed flags
   against the context-resolved defaults and returns `{ format, color }`. `resolveColorFlag(flags, env) =
   flags.color ?? env` — `??` (not `||`) so an explicit `--no-color` (`false`) wins over an env that says
   on, while unset falls through to the existing `ctx.colorEnabled` (`NO_COLOR`/TTY). The resolved `color`
   is then threaded explicitly into the renderers (`emitList(..., { color })`, `renderEndpoint(e, color)`,
   …) instead of each renderer reaching back to the context — so the override actually reaches the output.

## consequences

- `--color`/`--no-color` is a per-invocation override on top of the existing `NO_COLOR`/TTY default; a
  piped or CI run can force deterministic plain output (or force color through a pager) without env-var
  gymnastics.
- Every command resolves its flags through one helper, so D2b (NDJSON/exit-codes) and D3 (`--profile`) add
  cross-cutting flags in one place rather than nine.
- `apiUrl` is now declared once. This is a verified no-op on the security surface: it was already a flag on
  every affected command, and the value still flows through the `https`-only, query-stripping
  `resolveApiBaseUrl` (the bearer key cannot be downgraded to plaintext or redirected). `resolveGlobals`
  deliberately does not touch `apiUrl`.
- No behaviour change for a user who passes neither flag: the resolved `color` equals the old
  `ctx.colorEnabled`.

## alternatives considered

- **Resolve globals once in `buildContext`.** Impossible — the context is built before argv is parsed, so
  it can never see a flag value (only the env/TTY/stored layer). The merge must be per-handler.
- **Keep redeclaring flags per command.** Rejected — nine-way drift, and no single source for completions
  to read.
- **A `noColor` boolean instead of negating `color`.** Rejected — it collides with stricli's
  auto-generated `--no-color` negation and crashes `buildCommand` at load.
- **Thread the resolved color back through the context object.** Rejected — the context is shared/immutable
  per run and resolved pre-argv; passing `color` explicitly into the renderers keeps the data-flow obvious
  and unit-testable.
