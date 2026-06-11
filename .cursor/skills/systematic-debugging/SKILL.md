---
name: systematic-debugging
description: A disciplined 4-phase method for debugging in webhook.co — root-cause investigation, pattern analysis, hypothesis testing, then implementation. Use when chasing a bug or unexpected behavior instead of guessing-and-checking. Stop and review architecture after ~3 failed fixes.
---

# Systematic debugging

Find the root cause before changing code. Guess-and-check edits hide bugs instead of fixing them and
are especially dangerous on the correctness-critical paths (signing/verification, dedup, retries,
ordering, replay, metering). Work the four phases in order.

## Phase 1 — root-cause investigation

- Reproduce with the smallest case: endpoint setup, a redacted sample event, the exact request/command.
  Note environment and version.
- Follow the event id through ingest → DO → delivery using OpenTelemetry traces and logs. Inspect
  dedup/idempotency state, retry/backoff state, and signature verification.
- State what you *observe* vs what you *expect*. Don't theorize past the evidence yet.

## Phase 2 — pattern analysis

- Is this a one-off or a class of bug? Search for the same shape elsewhere (other surfaces, other
  endpoints) — parity means a bug in one surface often exists in the others.
- Check recent changes and the blast radius. Distinguish retryable from terminal failure: a "bug" is
  sometimes correct retry behavior reacting to a real downstream failure.

## Phase 3 — hypothesis testing

- Form one concrete, falsifiable hypothesis and design the cheapest test that would disprove it
  (a failing unit test, a targeted log/trace, a minimal repro).
- Change one variable at a time. Capture the result before forming the next hypothesis. Reproduce the
  bug reliably *before* attempting a fix — if you can't reproduce it, you can't confirm a fix.

## Phase 4 — implementation

- Once the root cause is confirmed, fix it under TDD: write the **regression test that fails without
  the fix** first (see `test-driven-development`), then implement the minimal correct fix.
- Verify the original repro is gone and nothing adjacent regressed.

## The 3-attempt stop rule

If three genuine fix attempts have failed, **stop thrashing.** Repeated failed fixes mean the mental
model is wrong, not that the next tweak will work. Step back and do an **architectural review**: write
down what you know, what each attempt assumed, and which assumption keeps being wrong; reconsider the
design or boundary involved; and bring in a second perspective (e.g. the `code-reviewer` agent) before
trying again. More attempts on a broken model just dig the hole deeper.

## Guardrails

- **Never** weaken the gate to move on: no `.only`/`.skip`/disabled tests, no lowered coverage, no
  `--no-verify`. Fix the root cause.
- **Redact PII/PHI** before quoting payloads or logs; reference events by id, never by contents.
- If the bug looks like a security issue (authz bypass, SSRF, secret/PII leak), escalate to a security
  review rather than patching ad hoc.
- Human-UI-testing hard stop: if confirming the fix needs human visual/interaction verification, flag it.

## Progressive disclosure

Keep decision trees (delivery-failure, signature-mismatch) and trace-reading playbooks in `references/`.
