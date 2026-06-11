---
name: build-mcp-server
description: Design and scaffold an MCP server for webhook.co. Use when adding or extending the MCP surface (apps/mcp), exposing a capability as MCP tools, or deciding how an MCP server should be deployed and structured.
---

# Build MCP server

MCP is a **first-class, non-negotiable surface** here: every capability is reachable identically from
CLI / API / web / MCP, and the MCP server ships as a real product surface (including the
webhook → agent trigger), not an afterthought. New work lives in `apps/mcp` and reuses the same
`shared/` types as the other surfaces — never invent an MCP-only payload shape.

Work through five phases. Don't skip to scaffolding.

## Phase 1 — interrogate the use case

Before any code, get crisp answers:

- What capability is being exposed, and does it already exist on CLI/API/web? If so, mirror its
  contract; if not, design for all four surfaces from the start (parity is the rule).
- Who calls it — an interactive agent, an automation, the webhook → agent trigger? What's the auth
  and tenant context? (Tenant isolation is enforced by Postgres RLS; the MCP layer must carry tenant
  identity, never bypass it.)
- What data crosses the boundary, and does any of it carry PII/PHI or raw payloads? Raw payloads live
  in R2 and are referenced by event id — don't pull bodies through MCP tool output.

## Phase 2 — recommend a deployment model

State a recommendation, don't list every option:

- **Remote streamable-HTTP on Workers (default here).** Our stack is TypeScript on Cloudflare
  Workers; host the MCP server as a Worker so it shares auth, bindings, and observability with the
  rest of the platform. This is the right answer for almost everything.
- **Elicitation** when a tool needs to ask the user for a missing input mid-call.
- **MCP app (interactive UI)** only when a widget genuinely beats text — see `build-mcp-app`, and
  respect the human-UI-testing hard stop.
- **MCPB bundle** only for a *local* stdio server a user installs on their machine — see `build-mcpb`.
- **Local stdio** only when the tool must touch the user's local environment (e.g. the CLI tunnel);
  otherwise prefer remote.

## Phase 3 — select a tool-design pattern

- **One tool per action** for a small, stable capability set — clearest for the model and the user.
- **Search + execute** when wrapping a large or open-ended API: a `search`/`list` tool to discover,
  then a focused `execute` tool, so the model isn't drowning in dozens of near-duplicate tools.
- Name tools for intent, validate every input at the boundary with a schema, and return typed,
  actionable errors — never leak stack traces, secrets, or tenant data in tool output.

## Phase 4 — pick a framework

- **TypeScript MCP SDK is the default and strongly preferred** — it matches the stack, shares
  `shared/` types, and deploys to Workers cleanly.
- Reach for FastMCP / Python only with an explicit, written justification (e.g. a Python-only
  dependency that can't be reasonably replaced). Document the tradeoff before committing.

## Phase 5 — scaffold

- Put the server in `apps/mcp`; keep the handler thin (validate → delegate → respond) and push real
  work into shared services, exactly like the Workers handlers.
- Use bindings (KV, R2, Hyperdrive, DO) — never hardcode endpoints or credentials; secrets via
  `wrangler secret`.
- Add tests for tool input validation and the unhappy paths (auth failure, tenant mismatch, malformed
  input) before wiring the happy path. See the `test-driven-development` skill.
- If the capability is new, open parity follow-ups for CLI/API/web so the surfaces don't drift.

## Guardrails

- MCP/AI-native parity is a non-negotiable: a capability added here is considered for all four surfaces.
- Standard-Webhooks-native signing/verification only; no hand-rolled schemes exposed through a tool.
- Public-safe repo: no pricing numbers, account/zone IDs, or business strategy in tool descriptions or code.

## Progressive disclosure

Keep deployment-model decision tables, a tool-schema template, and a Workers MCP starter in
`references/` rather than inlining them here.
