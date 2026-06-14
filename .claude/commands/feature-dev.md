# /feature-dev

Take a feature from a rough idea to reviewed, tested implementation through explicit phases. Don't
jump straight to code — move through the phases in order and check in at the gates.

## Phase 1 — discovery

Restate the goal in one line: who it's for, which surface(s) (CLI / API / web / MCP), and the outcome
they want. If the ask is vague, run the `brainstorming` skill / `/brainstorming` first and come back
with an agreed brief.

## Phase 2 — codebase exploration

Understand before changing. Find where this lives: the relevant `apps/*` and `packages/*`, the
`shared/` types, existing patterns for the same capability on other surfaces, and the tests that
cover the area. Note constraints discovered (DO ownership, RLS, the container-delivery seam). Use the
`Explore` subagent for broad searches when useful.

## Phase 3 — clarifying questions

Before designing, ask the questions whose answers would change the design — auth/tenant context, data
sensitivity (PII/PHI, raw payloads in R2), parity scope, ordering/performance needs, and which
non-negotiables apply. **Ask rather than assume.** Wait for answers on anything load-bearing.

## Phase 4 — architecture design (multiple approaches)

Present **two or three viable approaches** with concrete tradeoffs (complexity, parity cost,
performance, blast radius, how cleanly each respects the non-negotiables). Recommend one and say why
— have a point of view. Get agreement before implementing. Design for parity from the start: a
capability added to one surface is considered for all four, with shared `shared/` types.

## Phase 5 — implementation

Implement the agreed approach under TDD (failing test first → minimum code → refactor; see the
`test-driven-development` skill). Workers handlers stay thin (validate → delegate → respond); retries
via DO Alarms; delivery idempotent and dedup-by-event-id; Standard-Webhooks-native signing only;
open-core code must not import from `ee/`. For new MCP surface work, use the `build-mcp-server` skill.

## Phase 6 — quality review

Hand the diff to the existing **`code-reviewer`** agent. When behavior on a correctness-critical path
changed (signing/verification, dedup, retries, ordering, replay, metering, tenant isolation), also use
the **`qa-test-reviewer`** and **`security-reviewer`** agents. Address must-fix findings — don't merge
over them.

## Phase 7 — summary

Summarize what changed, test status, parity follow-ups for other surfaces, and an explicit list of
anything needing human verification.

## Hard rules (non-negotiable)

- **Human-UI-testing hard stop.** Anything needing human visual/interaction/copy verification —
  rendering, layout, design, UX, user-facing copy — **STOP and flag it for human testing.** Do not
  mark it done, approve, or merge until a human has verified it.
- **Never bypass the gate.** No `git commit --no-verify` / `git push --no-verify`, no `.only`/`.skip`/
  disabled tests, no lowered coverage. If the pre-commit/lint-staged hook fails, fix the root cause and
  commit again — CI required checks are the real gate, with no bypass for anyone.
- Stay public-safe: no pricing numbers, cost figures, account/zone IDs, or business strategy.
