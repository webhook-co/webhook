# AGENTS.md — webhook constitution & governance index

> **Read this first.** The shared, always-read context for every contributor and coding agent in
> this repository. It is the root "constitution" — the non-negotiables below hold across every
> surface and package. For a high-level overview, see [`README.md`](README.md). Claude Code reads
> this same file via [`CLAUDE.md`](CLAUDE.md).

## What this is

Open-core webhook infrastructure: **receive, inspect, replay-to-localhost, and reliably deliver**
webhooks. The wedge is a **free, permanent, signed webhook URL** with payload inspection and
one-command replay-to-localhost. From there it grows into **inbound ingestion** (verify → dedup →
retry → replay) and then **outbound delivery**. Every capability is reachable identically across
**CLI, API, web, and MCP**. Signing/verification follow the
**[Standard Webhooks](https://www.standardwebhooks.com/)** spec, for both **send** and **receive**.

## Non-negotiables (every change must respect these)

These are durable and rarely change. They are not bolt-ons — design for them from day one.

- **Compliance-by-design.** Encryption in transit and at rest; secrets in a KMS (never in source or
  plaintext config); an append-only, hash-chained (tamper-evident) audit log; tenant isolation via
  Postgres row-level security (RLS); region pinning; and PII/PHI scrubbing from logs.
- **MCP / AI-native parity.** Every capability is reachable from **CLI / API / web / MCP**
  identically. A capability added to one surface is considered for all. Ship the MCP server as a
  first-class surface, including the webhook → agent trigger.
- **Private-by-default.** Nothing is public, listed, or shared unless explicitly made so.
- **Cookieless ingestion on a separate apex.** Webhook ingestion and the CLI tunnel live on a
  **separate registrable apex** (`wbhk.my`): cookieless, no CORS, path-token routing, and a `404`
  for unknown tokens. Never serve ingestion from a primary application subdomain.
- **Standard-Webhooks-native.** Standard Webhooks is the contract for signing and verification, for
  both send and receive. Do not hand-roll signature schemes.
- **Open-core boundary.** The open core is **Apache-2.0**; proprietary code is fenced into `ee/`.
  Open-core code must not depend on `ee/` code; self-host builds simply exclude `ee/`.
- **Transparent pricing (qualitative).** Pricing stays transparent and predictable —
  **single-dimension (events), disclosed up front** (the billable unit — every captured request to an
  endpoint — is stated at endpoint creation and on the pricing page), with a **soft-cap that pauses
  rather than surprises**. No *surprise* billing: predictability comes from disclosure + alerts + pause,
  not hidden counters. This shapes engineering: keep event metering accurate and single-dimension;
  never build hidden per-step counters. (Specific prices, tiers, and cost figures are intentionally
  **not** in this public repo.)

## Engineering guardrails (non-negotiable, for humans and agents)

These two directives are absolute. They are not style preferences — violating them is never an
acceptable way to "make it pass." They bind every contributor and every coding agent equally.

1. **Human-UI-testing hard stop.** When a change requires human UI/visual verification that you
   cannot perform yourself — anything involving rendering, layout, visual design, interaction
   behavior, or user-facing copy a human must eyeball — **STOP and explicitly flag it for human
   testing.** Do **not** mark the task complete, do **not** approve, and do **not** merge until a
   human has verified it. Say plainly that human verification is required and what to check.

2. **Never bypass tests or weaken the gate.** Never use `git commit --no-verify` or
   `git push --no-verify`. Never add `.only`/`fdescribe`/`it.only`/`describe.only`, never skip or
   disable tests, and never lower a coverage threshold to get a green build. If tests fail, **fix
   the root cause.** The local hooks are a convenience and are bypassable; **CI required checks are
   the real gate and are mandatory for everyone, including admins** — status checks have no bypass.

## Tech stack

| Layer | Pick |
| --- | --- |
| Core engine | TypeScript on Cloudflare Workers |
| Ordering / isolation | Durable Objects, one per endpoint (FIFO + isolation) |
| Retry scheduling | Durable Object Alarms |
| Metadata / dedup | Neon Postgres via Hyperdrive (not D1) |
| Payload storage | Cloudflare R2 (batched payloads) |
| Heavy outbound delivery | Container compute behind an abstraction seam |
| Web / dashboard | TypeScript |
| MCP server | TypeScript on Workers |
| CLI / tunnel client | TypeScript (Bun `--compile` binary + npm) |
| SDKs | Generated via Speakeasy / Stainless |
| Observability | OpenTelemetry |

The core hosting/runtime is **Cloudflare-forward + TypeScript** (settled 2026-06-10). Keep the
**container-delivery seam** intact so the heavy-outbound compute lane can change without rippling
through the engine.

## Monorepo layout

Managed with **Turborepo**.

```
apps/
  api/      # REST API
  engine/   # core webhook engine (ingest / verify / deliver) — Workers + DO
  web/      # dashboard
  mcp/      # MCP server
packages/
  cli/           # TypeScript/Bun CLI + listen/replay-to-localhost
  sdks/          # generated client SDKs
  portal-sdk/    # embeddable portal SDK
  webhooks-spec/ # Standard Webhooks signing/verification helpers
  shared/        # shared utilities and types
ee/         # proprietary, license-fenced code (excluded from self-host builds)
infra/      # infrastructure and deployment configuration
```

## Brand voice (for any user-facing copy: docs, UI, CLI output, error messages)

Precise and quietly opinionated; casual-professional, writing developer-to-developer (contractions
welcome, no needless jargon); dry, sparing wit that never costs clarity. Brand names are always
lowercase: `webhook.co`, `wbhk.my`. Headings and UI labels use sentence case. When two good options
conflict, the tie-breakers are **clarity** and **trust**. Full guidance lives in the
`writing-voice` rule.

## Governance layer (how this repo guides agents)

This repo ships a "company-as-agents" governance layer. Cursor reads `.cursor/`; Claude Code reads
`.claude/` (mirrored skills and agents) plus this file via `CLAUDE.md`.

**Rules** — `.cursor/rules/*.mdc` (auto-attached by scope):

| Rule | Scope | Purpose |
| --- | --- | --- |
| `constitution` | always | The non-negotiable product principles every change must respect. |
| `no-secrets` | always | Never commit secrets, keys, or account identifiers. |
| `git-workflow` | always | Rebase on `main` before every PR; keep branches synced and rebase frequently. |
| `engineering-conventions` | `**/*.ts` | TypeScript / Workers conventions, error handling, testing. |
| `infra-devops` | `infra/**` | Cloudflare-forward guardrails; protect the delivery seam; no destructive infra without review. |
| `design-ux` | `apps/web/**`, `apps/www/**` | Accessibility and design-system / token conventions. |
| `data` | `**/db/**`, `**/migrations/**` | PII/PHI handling, safe migrations, metering integrity. |
| `writing-voice` | docs / web (agent-requested) | Keep docs and UI copy on-voice. |

**Skills** — `.cursor/skills/<name>/SKILL.md` (also mirrored in `.claude/skills/`):

- `infra-deploy-runbook` — deploy and operate the Cloudflare-forward stack safely.
- `docs-and-api-reference` — author docs and keep CLI/API/web/MCP reference at parity, on-voice.
- `data-migration` — plan and run safe, reversible schema/data migrations.
- `support-triage` — triage technical issues into reproducible, actionable reports.

These skills are **Cursor-side** (`.cursor/skills/`); the Claude mirror is maintained separately:

- `build-mcp-server` — design and scaffold an MCP server (5-phase), biased to remote HTTP on Workers.
- `build-mcp-app` — interactive MCP UI widgets in sandboxed iframes (respects the human-UI-testing stop).
- `build-mcpb` — package a local stdio server into an installable MCPB bundle.
- `test-driven-development` — strict red-green-refactor, tied to `no-skipped-tests` and coverage gates.
- `systematic-debugging` — 4-phase root-cause method; stop and review architecture after ~3 failed fixes.
- `brainstorming` — Socratic requirement refinement before any code.

**Commands** — `.cursor/commands/<name>.md` (Cursor-side slash commands; mirrored to Claude separately):

- `/feature-dev` — phased feature workflow (discovery → exploration → questions → design → build → review).
- `/brainstorming` — Socratic requirement refinement before code.
- `/execute-plan` — implement an agreed plan in reviewed batches with `code-reviewer` checkpoints.
- `/commit` — Conventional-Commits commit that refuses likely-secret files and never bypasses the hooks.
- `/commit-push-pr` — commit → push branch → open a PR with summary + test plan (via `gh`).
- `/clean-gone` — prune local branches whose remote was deleted.

**Hooks** — `.cursor/hooks.json` + `.cursor/hooks/` (Cursor-side):

- `security-scan` — after a file edit, scans the newly written content and surfaces advisory warnings
  (command injection in workflow files, unsafe `exec`/`execSync`, `eval`/`new Function`, XSS sinks,
  Python `pickle`/`os.system`) with remediation. Complements the static `eslint-plugin-security` gate;
  warns once per pattern per file and never blocks an edit.

**Sub-agents** — `.cursor/agents/*.md` (read-only reviewers; also mirrored in `.claude/agents/`):

- `security-reviewer` — injection/XSS/secrets/authz/SSRF and PII-in-logs review.
- `qa-test-reviewer` — coverage, edge cases, and behavioral completeness (can flag blocking).
- `code-reviewer` — correctness, maintainability, and convention adherence.

These reviewers are **Cursor-side** (`.cursor/agents/`); the Claude mirror is maintained separately:

- `silent-failure-hunter` — swallowed errors, empty catch blocks, ignored rejections, inadequate logging.
- `type-design-analyzer` — type invariants, encapsulation, making illegal states unrepresentable (TS).
- `comment-analyzer` — comments/docstrings checked for accuracy against the actual code.

> Sub-agents do **not** inherit this file's context, so each one restates the load-bearing policy it
> needs directly in its own prompt.
