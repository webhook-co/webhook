---
name: test-driven-development
description: Strict red-green-refactor TDD for webhook.co. Use when implementing or changing behavior — especially correctness-critical paths (signing/verification, dedup/idempotency, retries, ordering, replay, metering). Tests must fail before any implementation.
---

# Test-driven development

Write the test first, watch it fail, then make it pass. This is how the correctness-critical paths
here stay correct: Standard Webhooks signing/verification (send + receive), dedup/idempotency, retry/
backoff (DO Alarms), FIFO ordering (one DO per endpoint), replay-to-localhost, and single-dimension
metering.

## The loop (don't skip a step)

1. **Red — write a failing test.** Capture the desired behavior as a test before touching
   implementation. Assert the *right* outcome (status code, ordering, exactly-once effect), not just
   that code runs. **Run it and watch it fail for the expected reason.** A test that passes
   immediately, or fails for the wrong reason, isn't testing what you think.
2. **Green — minimum code to pass.** Write the least implementation that makes the test pass. No
   gold-plating, no unrelated changes.
3. **Refactor — clean up under green.** With the test green, improve names, structure, and duplication.
   Re-run; stay green.

Every bug fix starts with a regression test that fails without the fix. No behavior change lands
without a test that exercises it, including the unhappy path.

## What to cover

- Boundary validation of all external input (webhook bodies, API params, MCP tool input).
- Edge cases: malformed/oversized payloads, duplicate deliveries, out-of-order events, clock skew,
  partial failures, retries to exhaustion, replay idempotency, signature mismatch/expiry.
- Retryable-vs-terminal failure distinction, so the retry scheduler does the right thing.
- Prefer `vitest` with the Cloudflare Workers pool for DO/Workers code so tests run against the real runtime.

## The gate is non-negotiable

This ties directly to the repo's `no-skipped-tests` rule and coverage thresholds:

- **Never** add `.only` / `fdescribe` / `it.only` / `describe.only`, and **never** `.skip` / disable a
  test to get green. The `no-skipped-tests` check (wired into lint and CI) exists precisely to stop that.
- **Never** lower a coverage threshold to make a build pass.
- **Never** `git commit --no-verify` / `git push --no-verify`. If the pre-commit/lint-staged hook
  fails, fix the root cause and make a new commit. Local hooks are a convenience; **CI required checks
  are the real gate and have no bypass for anyone, including admins.**

If a test is genuinely wrong, fix the test deliberately and explain why — don't silence it.

## Human-UI-testing hard stop

TDD covers logic, not human perception. When correctness depends on rendering, layout, interaction, or
user-facing copy you can't verify yourself, **stop and flag it for human testing** — don't claim a UI
change is done because unit tests pass.

## Progressive disclosure

Keep per-surface test templates and Workers-pool setup snippets in `references/`.
