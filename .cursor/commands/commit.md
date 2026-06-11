# /commit

Create a commit that matches this repo's history, with the hooks doing their job.

## How to run

1. Inspect state in parallel: `git status`, `git diff` (unstaged) and `git diff --staged`, and
   `git log --oneline -15` to match the existing message style.
2. **Refuse to stage likely-secret files.** Never add `.env`/`.env.*`, credential files, key material
   (`*.pem`, `*.key`, `id_rsa`, `*.p12`), `*.crt`, cloud-credential JSON, or anything carrying tokens
   or account/zone IDs. If such a file is staged or requested, stop and warn me — don't commit it.
   (See the `no-secrets` rule.)
3. Stage the intended changes and write a **Conventional Commits** message matching history:
   `type(scope): subject` (e.g. `feat(engine):`, `fix(ci):`, `chore(deps):`). Subject in the
   imperative, concise; add a wrapped body explaining the *why* when the change isn't trivial. Pass
   the message via a heredoc so formatting survives.
4. Commit. **Let husky run.** The pre-commit hook runs lint-staged (eslint + prettier), the
   `no-skipped-tests` check, and typecheck.

## If the pre-commit hook fails

Fix the **root cause** and make a **new commit**. That's the whole point of the gate.

- **Never** `git commit --no-verify`, never disable or skip the husky hook, never `--no-verify` in any form.
- **Never** add `.only`/`.skip`/`fdescribe`/`xit`, disable a failing test, or lower a coverage threshold
  to get green.
- Local hooks are a convenience and are bypassable — but bypassing them is forbidden here. **CI required
  checks are the real gate and have no bypass for anyone, including admins.**

## Notes

- Don't push or open a PR — this command only commits. Use `/commit-push-pr` for the full flow.
- If the change includes user-facing UI/copy that a human must eyeball, say so: it still needs human
  verification regardless of a clean commit.
