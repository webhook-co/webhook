# webhook

Open-source webhook infrastructure — **receive, inspect, replay-to-localhost, and reliably
deliver** webhooks.

`webhook` gives you a signed webhook URL plus the tooling to understand and operate on what flows
through it:

- **Receive** — accept inbound webhooks at a stable, signed endpoint.
- **Inspect** — see full payloads, headers, and delivery metadata.
- **Replay to localhost** — forward any captured event to your local dev environment with one
  command, so you can iterate without redeploying.
- **Deliver** — send outbound webhooks reliably (ordered, retried) to downstream consumers.

Every capability is available identically across **CLI, API, web, and MCP**, and the
signing/verification model is **[Standard Webhooks](https://www.standardwebhooks.com/)**
compliant (both send and receive).

## Repository orientation

This repository is in early development. As code lands, it will be organized as a monorepo:

| Area | What it holds |
| --- | --- |
| `apps/` | Runnable services — API, engine, web dashboard, MCP server. |
| `packages/` | Shared libraries — CLI, SDKs, portal SDK, Standard Webhooks spec helpers, shared utilities. |
| `infra/` | Infrastructure and deployment configuration. |

See [`AGENTS.md`](AGENTS.md) for the technical context, tech stack, and conventions that contributors
and coding agents should follow.

## Status

Early/active development — the documentation here describes the project's direction and structure.

## Contributing / setup

**Coming soon.** Contribution guidelines, local setup, and a development quickstart will be published
as the codebase is scaffolded. In the meantime, issues and discussions are welcome.

## License

Apache-2.0 (open-source foundation). See `LICENSE` (to be added) for details.
