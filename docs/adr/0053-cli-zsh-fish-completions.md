# ADR 0053 — CLI zsh + fish completions (D4b)

- status: accepted (**D4b** — `wbhk completion zsh` + `wbhk completion fish`, completing the completion
  family started in D4a (bash). powershell is a later addition.).
- date: 2026-06-23
- scope: `packages/cli/src/commands/completion.ts` (+ tests); `.github/workflows/ci.yml`
  (`completion-smoke` extended with a zsh/fish parse check).
- relates: ADR-0051 (D4a bash completions + the `__complete` hook + the `bun --compile` bundle these reuse).
  `~/.claude/plans/cozy-greeting-cupcake.md` §D4b. Lane D.
- review severity: low (hand-authored shell scripts; no auth/secrets — the scripts only ever feed the
  `__complete` output to the shell's completion system, never `eval`/execute it). `/code-review` caught a
  BLOCKER (folded): the zsh slice `"${words[2,CURRENT]}"` JOINED the args into one word, so
  `wbhk events <TAB>` sent `"events "` not `events`+`""` — silently killing all subcommand/flag completion
  in zsh. Fixed with the `(@)` flag (`"${(@)words[2,CURRENT]}"`), verified by driving `_wbhk` (4 args,
  separate tokens) + a CI tokenization guard. **The interactive tab-completion in a real zsh/fish session
  is a HUMAN eyeball (needs-founder, per the plan) — CI parse-checks + a tokenization guard + the proven
  engine cover the mechanism, but the live tab behavior can't fully run in CI.**

## context

D4a shipped `wbhk completion bash` + the hidden `wbhk __complete` engine (`proposeCompletions` over the
live route/flag set, dispatched in bin.ts). D4b adds zsh + fish as two more sourceable scripts that defer
to the SAME `__complete` engine — so all shells stay in lock-step with the command set and nothing needs
regenerating.

## decision

1. **Same emit-model + engine as bash.** `wbhk completion <shell>` prints a static script; the script calls
   `wbhk __complete -- <words>` and feeds the newline-separated candidates to the shell. A `scriptCommand`
   factory backs all three subcommands (bash/zsh/fish); `2>/dev/null` everywhere so a stale binary yields
   no candidates rather than an error in the prompt.

2. **zsh passes the partial; fish passes the previous tokens + an explicit trailing `""`.** This is the one
   non-obvious bit. bash/zsh keep the (possibly empty) token under the cursor, so they pass it and let
   `proposeCompletions` filter (`${COMP_WORDS[@]:1:COMP_CWORD}` / `${words[2,CURRENT]}`; zsh splits with
   `${(@f)…}` + `compadd`). fish DROPS the empty current token, so the script passes `commandline -opc`
   (the previous tokens, after the program name) **plus a literal `""`** — `__complete` then returns the
   full candidate set for that position and **fish itself filters** by the token being typed. Without the
   trailing `""`, fish would lose subcommand completion right after a space.

3. **CI parse-checks the scripts (`zsh -n`, `fish --no-execute`).** A syntax typo in a hand-authored script
   would break a user's shell, which the unit tests (content assertions) can't catch — so the
   `completion-smoke` job installs zsh + fish and parse-checks the emitted scripts. The interactive tab
   behavior remains a human eyeball.

## consequences

- `wbhk completion {bash,zsh,fish}` all work off the one live engine; adding a command automatically
  completes in every shell with no script change.
- zsh was verified locally (`zsh -n` + the `${(@f)…}` split returns live proposals); fish is parse-checked
  in CI but its interactive behavior is unverified by me (no local fish) → flagged for the founder's
  real-shell check.

## alternatives considered

- **A completion framework / `@stricli/auto-complete`.** Rejected in D4a (install-to-rc, context-
  incompatible) and unchanged here — the emit-model is portable + testable, and zsh/fish are a few lines each.
- **Pass the partial to fish too (like bash/zsh).** Rejected — fish drops the empty current token after a
  space, breaking next-token completion; the previous-tokens-plus-trailing-`""` form is the robust fish idiom.
- **A zsh/fish interactive CI test.** Rejected — driving a real interactive completion in CI is brittle; a
  parse check + the proven `__complete` engine + a human eyeball is the right coverage split.
