# /brainstorming

Refine a requirement with me before any code gets written. Follow the `brainstorming` skill.

Act as a Socratic partner, not an order-taker. **Do not propose an implementation or write code in
this command** — the goal is a clear, agreed brief.

## How to run

1. Restate what I asked in one line — who it's for, which surface(s) (CLI / API / web / MCP), and the
   outcome I actually want. Wait for me to confirm or correct it.
2. Ask **one focused question at a time**, building on each answer. Probe:
   - the *why* and what success looks like concretely;
   - tenant/auth context and data sensitivity (PII/PHI, raw payloads live in R2, referenced by id);
   - parity expectations across surfaces;
   - which non-negotiables apply (compliance-by-design, Standard-Webhooks-native, private-by-default,
     open-core boundary, MCP/AI-native parity).
3. Offer two or three approaches with tradeoffs and say which you'd pick and why — don't just list them.
4. Pin scope: what's in, out, and deferred; name the riskiest assumption to validate first.

## Output

End with a short brief: problem, chosen direction (and the tradeoff that decided it), constraints it
must respect, surfaces touched, and open questions that still need a human answer. This brief is the
input to `/feature-dev` or a plan — don't start coding from an unconfirmed brief.

## Hard rules

- Stop and ask when the ask is ambiguous or conflicts with a non-negotiable — don't assume past it.
- If any part needs human UX judgment, flag it explicitly rather than deciding it yourself.
- Stay public-safe: no pricing numbers, cost figures, or business strategy.
