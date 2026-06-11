# /commit-push-pr

Commit the current work, push the feature branch, and open a pull request with a summary and a
test-plan checklist. Uses the GitHub CLI (`gh`).

## How to run

1. **Commit** following `/commit` exactly — match Conventional Commits style, refuse likely-secret
   files (`.env`, credentials, keys, account/zone IDs), and let husky run. If the pre-commit hook
   fails, fix the root cause and commit again.
2. **Branch.** If I'm on `main`/`master`, create a feature branch first (e.g. `feat/<short-slug>`);
   never commit feature work straight onto the default branch.
3. **Push** the feature branch with upstream tracking (`git push -u origin HEAD`). Let the pre-push
   hook run its affected tests.
4. **Open the PR** with `gh pr create`, passing the body via a heredoc:
   - **Summary** — what changed and why (1–3 bullets).
   - **Test plan** — a checklist of how it was/should be verified, including any surfaces touched
     (CLI / API / web / MCP) and parity follow-ups.
   - **Human verification** — an explicit checklist item for anything needing human UI/UX/copy review.
5. Return the PR URL.

## Hard rules (non-negotiable)

- **Never** `git commit --no-verify` or `git push --no-verify`; never skip or disable husky hooks.
  If a hook fails, fix the root cause and make a new commit — don't force a green.
- **Never** add `.only`/`.skip`/disabled tests or lower coverage to pass. The local hooks are a
  convenience; **CI required checks are the real gate and have no bypass for anyone, including admins.**
- **Never** force-push to `main`/`master`. Don't push secrets or files with account/zone IDs.
- **Human-UI-testing hard stop.** If the change includes UI/visual/copy that a human must verify, say so
  plainly in the PR and do **not** treat the PR as done or mergeable until a human has checked it.
