---
name: docs-and-api-reference
description: Author developer docs and reference, and keep CLI/API/web/MCP at parity and on-voice. Use when writing or updating docs, API/CLI/MCP reference, quickstarts, or changelogs.
---

# Docs & API reference

Produce clear, on-voice developer documentation and keep every surface documented at parity.

## Parity is the core job

A capability exists on **CLI, API, web, and MCP** identically — so it must be documented on all four.
When you document a feature:

1. Show it across each relevant surface (CLI command, API request, web flow, MCP tool).
2. Use the same payload/types across surfaces (sourced from `shared/`); don't invent per-surface
   shapes.
3. Cross-link the surfaces so a reader can switch between them.

## Voice & style

- Follow the `writing-voice` rule: precise, quietly opinionated, developer-to-developer, dry wit
  that never costs clarity.
- Lowercase `webhook.co` / `wbhk.my`; sentence case for headings and UI labels.
- Lead with what the reader can do; runnable examples over prose. Every code sample should work.

## Source of truth

- API reference is generated from the spec (SDKs via Speakeasy/Stainless) — keep prose docs in sync
  with the generated reference; don't hand-maintain endpoint tables that drift.
- Document Standard Webhooks signing/verification using the spec's terms (send and receive).

## Guardrails

- This repo is public-safe: **no prices, tiers, cost figures, margins, or business strategy** in any
  doc. Describe pricing only qualitatively (transparent, predictable, soft-cap that pauses) if at all.
- Never include secrets, real tokens, or account IDs in examples — use clear placeholders.

## Progressive disclosure

Keep this skill lean; put doc-site structure, frontmatter conventions, and per-surface example
templates in `references/`.
