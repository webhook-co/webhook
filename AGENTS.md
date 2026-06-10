# AGENTS.md — webhook project context

> **Read this first.** Concise, always-read technical context for contributors and coding agents
> working in this repository. For a high-level overview, see [`README.md`](README.md).

## What this is

Open-source webhook infrastructure: **receive, inspect, replay-to-localhost, and reliably deliver**
webhooks. Every capability is reachable identically across **CLI, API, web, and MCP**. Signing and
verification follow the **[Standard Webhooks](https://www.standardwebhooks.com/)** spec, for both
**send** and **receive**.

## Surfaces

The same functionality is exposed through four surfaces, which should stay at feature parity:

- **CLI** — local-first workflows, including tunnel/replay-to-localhost.
- **API** — REST surface for programmatic use.
- **web** — dashboard for inspection and management.
- **MCP** — MCP server so AI agents can use the product natively (including the webhook → agent
  trigger surface).

## Tech stack

| Layer | Pick |
| --- | --- |
| Core engine | TypeScript on Cloudflare Workers |
| Ordering / retry | Durable Objects per endpoint (FIFO + isolation) |
| Retry scheduling | Durable Object Alarms |
| Metadata / dedup | Neon Postgres via Hyperdrive |
| Payload storage | Cloudflare R2 (batched) |
| Heavy outbound delivery | Container compute behind an abstraction seam |
| CLI | TypeScript (Bun `--compile` binary + npm) |
| SDKs | Generated via Speakeasy / Stainless |
| Observability | OpenTelemetry |

## Monorepo layout & tooling

Monorepo managed with **Turborepo**.

```
apps/
  api/      # REST API
  engine/   # core webhook engine (ingestion, delivery)
  web/      # dashboard
  mcp/      # MCP server
packages/
  cli/           # TypeScript/Bun CLI
  sdks/          # generated client SDKs
  portal-sdk/    # embeddable portal SDK
  webhooks-spec/ # Standard Webhooks signing/verification helpers
  shared/        # shared utilities and types
ee/         # proprietary, license-fenced code (kept separate from the open core)
infra/      # infrastructure and deployment configuration
```

The open core is **Apache-2.0**. Proprietary code is fenced into `ee/` and is not part of the
open-source foundation.

## Architectural principles (compliance-by-design)

Build these into the architecture from day one; they are not bolt-ons:

- **Encryption** in transit and at rest; secrets held in a KMS, never in source or plaintext config.
- **Tenant isolation** — Postgres row-level security (RLS) enforced per tenant.
- **Audit logging** — append-only, tamper-evident (hash-chained) audit trail.
- **Region pinning** — data locality controls so records can be constrained to a region.
- **Private-by-default** — nothing is public, listed, or shared unless explicitly made so.
- **Cookieless ingestion** — webhook ingestion and the CLI tunnel live on a **separate registrable
  apex**: cookieless, no CORS, path-token routing, and a `404` for unknown tokens. Ingestion is
  never served from a primary application subdomain.

## Coding conventions

- **TypeScript everywhere** across engine, apps, and CLI; prefer strict typing.
- **Standard Webhooks** is the contract for signing/verification — do not hand-roll signature
  schemes.
- Keep the **CLI / API / web / MCP** surfaces at parity; a capability added to one should be
  considered for all.
- Respect the **`ee/` boundary** — open-core code must not depend on proprietary `ee/` code.
- Favor the **abstraction seam** for heavy outbound delivery so the compute lane can change without
  rippling through the engine.
- Keep secrets, tokens, and tenant data out of logs (scrub PII/PHI).
