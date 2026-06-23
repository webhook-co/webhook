# ADR 0054 — CLI `replay --edit` (edit a captured payload before forwarding) (D9)

- status: accepted (**D9** — `wbhk replay <id> --edit`: open the captured body in `$EDITOR`, then forward
  the edited bytes to localhost. A delighter on top of the shipped `replay --forward`.).
- date: 2026-06-23
- scope: `commands/replay.ts` (`--edit` flag + flow); new `src/edit.ts` (pure helpers) + tests; a new
  `editText` io seam (`context.ts` + `io.ts` + `makeTestContext`).
- relates: the shipped `replay --forward` path + `forward.ts`. `~/.claude/plans/cozy-greeting-cupcake.md`
  §D9. Lane D.
- review severity: medium (spawns an external editor; writes a possibly-sensitive payload to a temp file).
  `/code-review` + `/security-review`. Folded: a MAJOR (a trailing-newline an editor adds on a no-op `:wq`
  spuriously counted as an edit → now `applyEdit` treats a one-trailing-newline diff as unchanged, forwards
  the original bytes, no warning) + a security MINOR (the temp dir could leak the payload if `writeFileSync`
  threw after `mkdtemp` → the whole `editText` setup is now guarded + cleaned up; + an explicit `chmod 0600`
  and the dead `cmd ??` removed). **The interactive editor round-trip is a coverage-excluded io seam (faked
  in tests; the mechanism smoke-verified with a non-interactive fake editor) — a real-editor eyeball is a
  nice-to-have, not a gate, since the logic is fully unit-tested.**

## context

`replay --forward` re-delivers a captured event to a local dev server byte-for-byte. D9 adds `--edit` so
you can tweak the payload first (exercise an edge case in a local handler). The crux is the signature:
the captured `webhook-*` headers carry the ORIGINAL sender's (provider's) signature over the original
body, and webhook.co never holds that third-party secret — so an edited body's signature CANNOT be
recomputed. We therefore forward the edited body with the original headers and WARN that the signature no
longer matches, rather than silently ship a payload the handler will reject (the plan's "preserve" option;
"recompute" isn't feasible).

## decision

1. **`--edit` opens the body in `$EDITOR` via the `editText` io seam.** Flow: fetch the event + body →
   resolve the editor (`editorFromEnv`: `$VISUAL` then `$EDITOR`; a usage error if neither) → decode the
   body to UTF-8 text (`decodeEditableBody`; a usage error if it isn't valid UTF-8 — `--edit` won't mangle
   a binary payload) → `io.editText(text, editor)` → encode the result → forward THOSE bytes. The pure bits
   (`editorFromEnv`, `decodeEditableBody`) are unit-tested; the spawn is the seam.

2. **The original signature is preserved + a caveat is printed when the body changes.** We can't re-sign
   (the provider's secret is the sender's, never ours), so the forwarded request keeps the original
   `webhook-*` headers; if the edited text differs from the original, we note that the signature won't
   verify. An unchanged save forwards exactly like a plain replay (no warning).

3. **The `editText` seam writes a 0600 temp file and always cleans up.** The payload may be PII/PHI, so the
   real impl writes it `0600` inside a private `mkdtemp` dir and `rm`s the dir in a `finally` (success,
   non-zero editor exit, or spawn error). The editor string is split on spaces (so `code --wait` works) and
   spawned WITHOUT a shell (no injection from the editor string or the controlled temp path); the file is
   passed LAST (the `$EDITOR` convention). A non-zero editor exit aborts the replay (nothing forwarded).

## consequences

- `wbhk replay <id> --edit --forward <localhost>` lets you mutate a real captured payload to test a handler;
  the signature caveat keeps the behavior honest (the handler will reject an edited body if it verifies).
- No new dependency, no new scope, no signing-secret handling (re-signing is out of scope + infeasible).
- The interactive editor experience is unverified in CI (coverage-excluded seam) — the orchestration is
  fully unit-tested with a fake editor, and the real mechanism (round-trip, 0600, cleanup, arg ordering)
  was smoke-verified locally with a non-interactive fake editor.

## alternatives considered

- **Re-sign the edited body.** Rejected — the signature is the third-party sender's; webhook.co doesn't
  hold that secret, and exposing any signing secret to the CLI would be new scope + a security surface.
- **Let `--edit` also edit the headers.** Deferred — body-only is the 80% case; header editing adds a
  re-parse surface for little v1 value.
- **Refuse `--edit` outright when the body changed (since the sig won't verify).** Rejected — editing to
  test the reject path (or a dev handler that skips verification) is exactly the use case; a warning is the
  right call, not a block.
