---
name: build-mcp-app
description: Build interactive MCP UI widgets (forms, pickers, confirmation dialogs, charts, live status) rendered in sandboxed iframes. Use when an MCP tool genuinely needs a visual/interactive surface instead of text. Pairs with build-mcp-server.
---

# Build MCP app

An MCP app is an interactive widget — a form, picker, confirmation dialog, chart, or live status view
— that an MCP host renders in a **sandboxed iframe**. Use it only when a widget genuinely beats a
text exchange (e.g. confirming a destructive replay, picking an endpoint, watching delivery status
live). Most tools should stay text-first; reach for a UI when interaction or at-a-glance state is the
point.

## Human-UI-testing hard stop (read first)

Anything an MCP app renders is **user-facing UI**. The repo's non-negotiable applies in full: when a
change needs human visual/UX verification you can't do yourself — layout, rendering, interaction
behavior, or any user-facing copy — **STOP and explicitly flag it for human testing.** Do not mark
the widget done, approve it, or merge it until a human has eyeballed it. Say plainly what to check
(states, edge cases, copy).

## When a widget is worth it

- **Confirmation dialog** for irreversible or cross-tenant-sensitive actions (replay, delete) — make
  the consequence explicit before the user commits.
- **Picker / form** when free-text would be error-prone (choosing an endpoint, a time window, an event).
- **Chart / live status** when trends or real-time delivery state are easier to read visually than as text.

If a plain text response answers the question, don't build a widget.

## Build guidance

- Treat the iframe as **untrusted and sandboxed**: no ambient credentials inside the widget; pass only
  the minimum data needed, and keep all privileged work behind the MCP server (validate → delegate →
  respond), never in the widget.
- Never render raw webhook payloads or PII/PHI in a widget; reference events by id and show redacted
  summaries.
- Reuse `shared/` types for anything the widget exchanges with the server — don't invent UI-only shapes.
- Follow the design-ux conventions (accessibility, design tokens) and the `writing-voice` rule for all
  labels and copy: sentence case, lowercase `webhook.co` / `wbhk.my`, precise and quietly opinionated.

## Guardrails

- MCP/AI-native parity still holds: a widget is a presentation of a capability, not a new capability
  that only exists in MCP.
- Private-by-default: a widget never exposes another tenant's data; tenant isolation (RLS) is enforced
  server-side, never assumed in the iframe.
- Public-safe repo: no pricing numbers or account/zone IDs in widget code or copy.

## Progressive disclosure

Keep widget templates, the host/iframe message contract, and accessibility checklists in `references/`.
