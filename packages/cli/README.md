# wbhk — the webhook.co CLI

Capture, inspect, and replay webhooks from your terminal. `wbhk` gives you a free, permanent, signed
webhook URL, streams deliveries to your machine, and replays them to localhost with one command — so you
can build and debug webhook integrations without redeploying or clicking through a dashboard.

## Install

```sh
# npm (needs Node >= 20)
npm install -g wbhk
# or run without installing
npx wbhk --help

# standalone binary (macOS / Linux / Windows — no Node required)
curl -fsSL https://get.webhook.co | sh
```

Prebuilt binaries for every platform are also attached to each [GitHub release](https://github.com/webhook-co/webhook/releases).

## Quickstart

```sh
wbhk login                      # authenticate (opens your browser)
wbhk listen <endpoint-id>       # stream live deliveries to your terminal
wbhk listen <endpoint-id> --forward localhost:3000   # replay each one to your app
wbhk replay <event-id> --forward localhost:3000   # replay a past event to your app
wbhk doctor                     # check auth, connectivity, and config
```

Everything is scriptable — add `--output json` to any read command and pipe it into `jq`. Run
`wbhk --help` (or `wbhk <command> --help`) for the full surface.

## How it works

`wbhk` talks to webhook.co's API and opens a signed tunnel to stream deliveries to your machine. Signing
and verification follow the [Standard Webhooks](https://www.standardwebhooks.com/) spec. Nothing is public
unless you make it so, and credentials are stored in your OS keychain when one is available.

## Links

- Docs: https://webhook.co
- Source: https://github.com/webhook-co/webhook (`packages/cli`)
- Issues: https://github.com/webhook-co/webhook/issues

Apache-2.0.
