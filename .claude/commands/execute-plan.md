# /execute-plan

Implement an agreed plan in reviewed batches, not one giant uninterrupted run. Use this after a plan
exists (from `/brainstorming`, `/feature-dev`, or a written design).

## How to run

1. **Confirm the plan.** Restate the batches you'll implement and their order. If there's no clear
   plan yet, stop and ask for one (or run `/brainstorming` first). Don't improvise scope.
2. **Work one batch at a time.** For each batch:
   - Implement it under TDD — failing test first, then the minimum code to pass, then refactor (see
     the `test-driven-development` skill).
   - Keep changes scoped to the batch; don't drift into unrelated edits.
3. **Review checkpoint after each batch.** Hand the diff to the `code-reviewer` agent (and the
   `qa-test-reviewer` agent when behavior on a correctness-critical path changed — signing/verification,
   dedup, retries, ordering, replay, metering). Address must-fix findings before moving on.
4. **Pause for me** at each checkpoint with a one-line status: what landed, what the review said, and
   what's next. Don't barrel through all batches silently.
5. **Summarize** at the end: what changed, test status, follow-ups, and anything needing human verification.

## Hard rules

- **Never bypass the gate.** No `git commit --no-verify` / `git push --no-verify`, no `.only`/`.skip`/
  disabled tests, no lowered coverage thresholds. If the pre-commit/lint-staged hook fails, fix the
  root cause and make a new commit — CI required checks are the real gate and have no bypass.
- **Human-UI-testing hard stop.** If a batch needs human visual/interaction/copy verification, stop and
  flag it for human testing; don't mark it done on your own.
- Keep CLI/API/web/MCP at parity; reuse `shared/` types. Stay public-safe (no pricing/account IDs).
