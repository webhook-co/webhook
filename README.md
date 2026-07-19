# webhook.co

**A free, permanent, signed webhook URL you can inspect and replay to localhost — from the CLI, API,
dashboard, or MCP.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![CLI on npm](https://img.shields.io/npm/v/%40webhook-co%2Fcli?label=cli&logo=npm)](https://www.npmjs.com/package/@webhook-co/cli)
[![CI](https://img.shields.io/github/actions/workflow/status/webhook-co/webhook/ci.yml?branch=main&label=ci)](https://github.com/webhook-co/webhook/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-docs.webhook.co-informational)](https://docs.webhook.co)

`webhook.co` captures the webhooks other services send you, so you can see exactly what arrived,
check the signature, and replay it to your local dev server without redeploying. The same operations
run from the CLI, the REST API, the web dashboard, and an MCP server.

- **Receive** — a stable, signed URL on a dedicated apex (`https://wbhk.my/<token>`). No expiring
  tunnels.
- **Inspect** — every request, headers and body, with a clear signature result.
- **Replay to localhost** — forward any captured event to `http://localhost:3000` with one command.
- **Deliver** — send events on to your own destinations, in order, with retries.

**Want to see it work first?** Open **[webhook.co/play](https://webhook.co/play)** — send a webhook,
watch it land. No signup, nothing to install.

Open source · Apache-2.0 · private by default.

## Try it in 60 seconds

Sign in, create an endpoint, forward its webhooks to your machine, and send it a test request. No
install needed — this uses `npx` (Node 22+):

```sh
# 1. sign in — opens your browser (GitHub or Google) and creates your free account
npx @webhook-co/cli login

# 2. create an endpoint — it prints an id and your permanent, signed ingest URL:
npx @webhook-co/cli endpoints create orders
#    id          d7e4f8a1-3b60-4c2e-9f15-0a8c6b2e1d94
#    ingest url  https://wbhk.my/whep_8QmZ4tN1p…

# 3. forward that endpoint's events to your local server (leave this running)
npx @webhook-co/cli listen d7e4f8a1-3b60-4c2e-9f15-0a8c6b2e1d94 --forward http://localhost:3000

# 4. in another terminal, send it a test request — or point Stripe, GitHub, Shopify, … at the URL
curl -X POST https://wbhk.my/whep_8QmZ4tN1p… -d '{"hello":"webhook.co"}'
```

Each captured event prints one line — timestamp, provider, signature result, id — then the result of
forwarding it to your local server (example output):

```text
2026-07-19T14:02:03.517Z  —  unverified  6b1f0c2a-9d84-4e02-b7a1-2c5f8e30a1bd
forwarded 6b1f0c2a-9d84-4e02-b7a1-2c5f8e30a1bd → http://localhost:3000 · 200 · 12ms
2026-07-19T14:02:11.884Z  github  verified  a0c33f19-72d6-4b58-8e41-6f9b0d2c4a77
forwarded a0c33f19-72d6-4b58-8e41-6f9b0d2c4a77 → http://localhost:3000 · 200 · 9ms
```

`--forward` targets must be a full loopback URL (`http://localhost:3000`,
`http://127.0.0.1:8080/webhooks`). Replay a past event with
`wbhk replay <event-id> --forward http://localhost:3000`.

Prefer a permanent install? Pick one:

```sh
brew install webhook-co/tap/wbhk           # Homebrew (macOS / Linux)
npm install -g @webhook-co/cli             # npm — installs the wbhk command
curl -fsSL https://get.webhook.co | sh     # standalone binary, no Node required
```

Full walkthrough: **[docs.webhook.co/quickstart](https://docs.webhook.co/quickstart)**.

## What you get

**A permanent, signed URL that captures first.** Every request is written to durable storage the
instant it lands — before verification or dedup run — so a bad signature, an unknown provider, or a
downstream outage only changes what happens *next*, never whether you have the event. The ingest URL
is a sealed credential you can re-read on demand and rotate in place, not a secret shown once.

**Verification for 142 providers, built in.** One open registry
([`packages/webhooks-spec`](packages/webhooks-spec)) covers Stripe, GitHub, Shopify, Slack, Twilio,
Square, PayPal, Discord, Clerk, Supabase, and [many more](https://docs.webhook.co/providers/directory).
Every event is sorted into one of four states — **verified** (a cryptographic signature checked),
**authenticated** (source proven by a shared secret, no payload signature), **failed** (a signature
was checked and rejected), or **unattempted** — and a failure names the likely cause instead of
stopping at "no signatures found." Signing and verification follow the
[Standard Webhooks](https://www.standardwebhooks.com/) spec, for both receive and send.

**Reliable outbound delivery.** Forward captured events to your own destinations with strict FIFO
ordering (one Durable Object per destination), at-least-once delivery, retries on exponential backoff,
and dead-lettering once a destination exhausts its retries. Deliveries carry a fresh signature only
for events `webhook.co` verified or authenticated; anything it couldn't vouch for is relayed unsigned.
Optional per-endpoint deduplication collapses repeats by Standard-Webhooks id, provider event id, a
content hash, or JSON fields you choose.

**Replay on demand.** Re-send any captured event still within your retention window — to localhost or
to a registered destination — to fix a handler or recover from an outage, without asking the provider
to send it again.

**Private by default, with the controls built in.** Nothing is public unless you make it so. Tenant
isolation is enforced by Postgres row-level security; secrets are envelope-encrypted under a KMS;
traffic is encrypted in transit and at rest; and privileged actions land in an append-only,
hash-chained audit log with a verifier (`wbhk audit verify`) that proves the chain hasn't been
altered.

**One capability contract, four surfaces.** Every capability is defined once and bound identically to
the CLI, the REST API, the web dashboard, and the MCP server. A parity gate fails the build if a
surface forgets one — so the surfaces don't drift.

## Built for agents

An inbound webhook can wake an agent that's waiting on it. The
[MCP server](https://docs.webhook.co/mcp/overview) at `mcp.webhook.co` is a first-class surface
(remote HTTP on Cloudflare Workers, OAuth-authorized), and `triggers.wait` is the primitive: an agent
registers a trigger on an endpoint and drains new events since its last cursor — at-least-once, in
capture order per endpoint, held durably while the agent is offline, with the verified payload inline
(up to 64 KiB). MCP itself has no native inbound trigger yet.

Egress-configuring capabilities (registering replay destinations and subscriptions) are deliberately
kept off MCP, and localhost replay stays CLI-only — a confused-deputy and SSRF precaution, not a
missing feature.

## SDKs and CLI

Three official client SDKs, generated from the same OpenAPI contract as the API, plus the `wbhk` CLI.
Each SDK ships bearer auth, bounded retries with jitter, cursor pagination, idempotency, and secret
redaction.

| Language | Install | Import |
| --- | --- | --- |
| **TypeScript** | `npm install @webhook-co/sdk` | `import { WebhookClient } from "@webhook-co/sdk"` |
| **Python** | `pip install webhook-co` | `from webhook_co import WebhookClient` |
| **Go** | `go get github.com/webhook-co/webhook-go` | `import webhook "github.com/webhook-co/webhook-go"` |
| **CLI** | `brew install webhook-co/tap/wbhk` | the `wbhk` command |

The TypeScript SDK runs anywhere `fetch` does (Node 18+, browsers, Deno, Bun, Workers). The Python
SDK needs Python 3.10+. The Go SDK needs Go 1.22+ and has zero third-party dependencies — standard
library only — and lives in its own repository,
[`webhook-co/webhook-go`](https://github.com/webhook-co/webhook-go).

The REST API lives at `https://api.webhook.co/v1`, authenticated with a `whk_` bearer key, and is
described by a machine-readable OpenAPI 3.1 document at
[`api.webhook.co/openapi.json`](https://api.webhook.co/openapi.json) — the one source that also
generates the SDKs and the docs.

Distribution is independently verifiable: npm packages are published with provenance
(`npm audit signatures`), and the standalone CLI binaries carry sigstore-signed SLSA build provenance
(`gh attestation verify wbhk-<os>-<arch> --repo webhook-co/webhook`).

## Pricing

`webhook.co` is free to start: a permanent signed URL, inspect, and replay, with **5,000 events to
spend once** — a real trial allowance that never resets. Paid plans (Pro, Scale, Enterprise) price on
a **single dimension — events** — with a soft cap that **pauses capture rather than surprising you
with a bill**. The whole receive → verify → deliver → replay pipeline, outbound delivery included, is
on every plan; plans differ by event volume and retention window. Full numbers:
**[webhook.co/pricing](https://webhook.co/pricing)**.

## How it's built

`webhook.co` is a Turborepo + pnpm-workspaces monorepo. The core engine is TypeScript on Cloudflare
Workers; ordering and isolation come from one Durable Object per destination, with Durable Object
Alarms driving retry scheduling; metadata and dedup live in Neon Postgres via Hyperdrive; and payloads
are stored content-addressed in R2. Ingestion runs on a **separate registrable apex, `wbhk.my`** —
cookieless, no CORS, path-token routed, with a `404` for unknown tokens — deliberately isolated from
the primary application domain.

```
apps/
  api/         REST API                          (api.webhook.co)
  engine/      capture / verify / deliver — Workers + Durable Objects
  web/         dashboard                         (app.webhook.co)
  www/         marketing site                    (webhook.co)
  docs/        documentation                     (docs.webhook.co)
  mcp/         MCP server                        (mcp.webhook.co)
  auth/        identity / OAuth issuer           (auth.webhook.co)
  play/        no-signup playground              (webhook.co/play)
  get/         CLI install shim                  (get.webhook.co)
  telemetry/   anonymous, opt-out CLI telemetry
packages/
  cli/            the wbhk CLI + listen / replay-to-localhost
  webhooks-spec/  Standard Webhooks signing + the 142-provider registry
  contract/       the capability contract + cross-surface parity gate
  sdk-ts/         the TypeScript SDK (@webhook-co/sdk)
  shared/         shared types, the plan catalog, utilities
  ui/             shared UI components
  portal-sdk/     embeddable portal SDK
ee/            proprietary, license-fenced (excluded from self-host builds)
infra/         infrastructure as code
sdks/python/   the Python SDK (webhook-co)
```

[`AGENTS.md`](AGENTS.md) is the constitution — the shared context, conventions, and non-negotiables
every contributor and coding agent follows.

## Open core

The core — the delivery/ingestion engine, the CLI and replay client, the MCP server, the SDKs, and
the Standard-Webhooks signing implementation — is **Apache-2.0**. Proprietary features live behind the
[`ee/`](ee) fence and are excluded from self-host builds; open-core code never imports from `ee/`.
Open source exists here for transparency and trust; an open, shared webhook interop standard — not a
restrictive license — is the point.

## Contributing

Setup is `pnpm install` (Node 24, pinned in [`.nvmrc`](.nvmrc); pnpm via `corepack enable`). The
everyday loop:

```sh
pnpm lint          # ESLint (incl. security rules) + repo guards
pnpm format        # Prettier
pnpm typecheck     # tsc across the workspace
pnpm test          # Vitest
pnpm build         # turbo build
```

Changes land via pull request to `main` behind required CI checks and a review. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the full setup, the check gate, and the merge model. Issues
and discussions are welcome.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md). Don't open a public issue
for a security report.

## License

[Apache-2.0](LICENSE) for the open core. See [`NOTICE`](NOTICE) for attribution and the
[`ee/`](ee) directory for the separately-licensed proprietary components.

---

Docs: [docs.webhook.co](https://docs.webhook.co) · Playground:
[webhook.co/play](https://webhook.co/play) · Changelog:
[docs.webhook.co/changelog](https://docs.webhook.co/changelog)
