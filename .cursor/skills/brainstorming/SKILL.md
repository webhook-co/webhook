---
name: brainstorming
description: Socratic requirement refinement before writing code. Use at the start of a non-trivial feature or change to turn a vague ask into clear, agreed requirements and constraints. Pairs with the /brainstorming command and feeds /feature-dev.
---

# Brainstorming

Refine the requirement before touching code. Most wasted work comes from building the wrong thing
confidently — this skill front-loads the questions so the design that follows is aimed correctly.

## Method — ask before you build

Work as a Socratic partner, not an order-taker. One focused question at a time; build on the answers.

1. **Restate the goal** in one line: who is this for, which surface(s) (CLI/API/web/MCP), and what
   outcome do they actually want? Confirm the restatement before going further.
2. **Probe the why.** What problem does this solve? What happens if we don't build it? What does
   success look like, concretely?
3. **Surface constraints and unknowns.** Tenant/auth context, data sensitivity (PII/PHI, raw payloads),
   parity expectations across surfaces, performance and ordering needs, and the non-negotiables that
   apply (compliance-by-design, Standard-Webhooks-native, private-by-default, open-core boundary).
4. **Explore alternatives.** Name two or three approaches with their tradeoffs; have a point of view
   on which is right and why. Don't just enumerate.
5. **Pin down scope.** What's explicitly in, what's out, and what's deferred. Identify the riskiest
   assumption to validate first.

## Output

A short, agreed brief: the problem, the chosen direction (with the tradeoff that decided it), the
constraints it must respect, the surfaces it touches, and the open questions still needing a human
answer. This brief is the input to `/feature-dev` or an implementation plan — don't start coding from
an unconfirmed brief.

## Guardrails

- Stop and ask when the ask is ambiguous, conflicts with a non-negotiable, or would need human UX
  judgment — don't paper over it with assumptions.
- Keep parity in view: a capability on one surface is considered for all four.
- Public-safe: no pricing numbers, cost figures, or business strategy in the brief.

## Progressive disclosure

Keep question banks and a brief template in `references/`.
