# ADR 0051 — CLI bash completions + a working `bun --compile` bundle (D4a)

- status: accepted (**D4a** — bash shell tab-completion, plus the bundle fix that makes the standalone
  `wbhk` binary buildable for the first time — a prerequisite for proving completions from the compiled
  artifact. zsh/fish are D4b.).
- date: 2026-06-22
- scope: new `packages/cli/scripts/bundle.mjs` + `package.json` `bundle` script; new
  `packages/cli/src/commands/completion.ts`; `src/bin.ts` (`__complete` dispatch); `src/app.ts` (register
  the `completion` route); new `.github/workflows/ci.yml` `completion-smoke` job.
- relates: the plan `~/.claude/plans/cozy-greeting-cupcake.md` §D4. Lane D. (The plan said "ADR: none";
  recorded anyway because of the bundle-tooling fix + the dependency decision + the new CI job.)
- review severity: medium (build tooling + CI; no auth/secrets). `/code-review` + `/security-review` — both
  SHIP, no blockers. Folded: `bundle.mjs` SELF-HEALS a prior interrupted run (restores a stranded stash on
  startup); `*.bundlebak` is now git-ignored; the bun CI install carries an explicit "version-pinned, not
  SHA-pinned — CI-only, no secrets, unshipped" rationale (the deliberate delta vs the dbmate SHA-pin in the
  same file); the smoke `rm -f`s the binary before building (never assert a stale artifact).

## context

Stricli generates no completion scripts (only `proposeCompletions`). The plan called for
`@stricli/auto-complete`, but on inspection that package is an *install-to-`~/.bashrc`* model whose
`StricliAutoCompleteContext` requires real Node `WriteStream`s — incompatible with our `{ write }`-shaped
`AppContext.process` — and writing the user's rc is invasive + hard to test. Separately, during the D8c3a
verification we found `bun build --compile` was BROKEN: it honors the package tsconfig's `paths` (the
node↔workers `@webhook-co/* → dist/index.d.ts` redirect, a typecheck-only boundary) at bundle time and
resolves the deps to type-only `.d.ts` (no runtime exports → "no matching export"). So the CLI had never
actually built as a binary, and the completion gate ("prove the hook fires from a `bun --compile` binary")
couldn't be met until that was fixed.

## decision

1. **Emit-model completions, not `@stricli/auto-complete`.** `wbhk completion bash` prints a sourceable
   script (the gh/kubectl pattern: `source <(wbhk completion bash)`); the script defers every keystroke to
   the hidden `wbhk __complete`, which calls `@stricli/core`'s `proposeCompletions` — so completions always
   reflect the LIVE command/flag set and the script never needs regenerating. Needs only core (no new dep),
   and is fully unit-testable. bash only for now (zsh/fish = D4b).

2. **`__complete` is dispatched in `bin.ts`, not registered as a route.** This keeps it out of `--help` and
   out of its own completion candidates (it's an internal engine), and avoids an `app`↔command import cycle
   (a `__complete` command would have to import `app` to pass to `proposeCompletions`). The logic
   (`runCompletionProposals`) is a separately-exported, unit-tested function; `bin.ts` (coverage-excluded
   wiring) just strips the bash `--` separator and calls it. The compiled binary is exercised in CI.

3. **`scripts/bundle.mjs` makes `bun --compile` work.** It moves `packages/cli/tsconfig.json` aside for the
   duration of the bundle — so bun resolves the workspace deps to their TS source via each package's
   `exports` map instead of the typecheck-only `.d.ts` — and ALWAYS restores it (the restore runs before the
   deferred `process.exit`, since `process.exit` skips `finally`). Deterministic; no reliance on undocumented
   bun bundler flags. tsc/typecheck/the tsconfig-boundary gate are untouched (they still use the real
   tsconfig with its `paths`).

4. **A `completion-smoke` CI job proves the hook from the compiled artifact.** Vitest/tsc can't cover the
   bundle's source-resolution or the binary's `__complete` dispatch, so the job installs bun via the
   official install script (a run step — NOT a 3rd-party marketplace action, which the org blocks — pinned
   to a version), builds the binary, and asserts `completion bash` emits the registration and `__complete`
   returns live proposals. It is the plan's self-merge gate. Not yet a *required* check — add it to the
   `main` ruleset to make it blocking.

## consequences

- `wbhk completion bash` + `wbhk __complete` work from the shipped binary (CI-proven); tab-completion
  reflects the live command set.
- The standalone `wbhk` binary builds for the first time — `scripts/bundle.mjs` unblocks any future
  distribution work, independent of completions.
- No new runtime dependency (`@stricli/auto-complete` was evaluated + rejected).
- The bundle moves the tsconfig aside transiently; `tsconfig.json.bundlebak` is an internal artifact,
  git-ignored (`*.bundlebak`) and always restored — and if a hard kill ever strands it, the next run
  self-heals (restores the stash before starting) rather than wedging the repo.

## alternatives considered

- **`@stricli/auto-complete` (install-to-rc).** Rejected — its context requires Node `WriteStream`s
  (incompatible with our process seam), it mutates `~/.bashrc`, and it's hard to unit-test. The emit-model
  is the portable, testable standard.
- **`__complete` as a hidden route.** Rejected — stricli's route builder has no per-route `hidden` flag, it
  would appear in help, and it forces an `app`↔command import cycle.
- **`tsconfig.bundle.json` + a bun tsconfig-override flag.** Rejected — `bun build` has no documented
  tsconfig override; the undocumented flag threw an internal error. The move-aside wrapper is deterministic.
