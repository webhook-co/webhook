# apps/docs — webhook.co documentation (Mintlify)

The developer documentation for [docs.webhook.co](https://docs.webhook.co), built with
[Mintlify](https://mintlify.com). It sits alongside the other product surfaces in `apps/`, but unlike them
it is **not** a pnpm/turbo workspace package — it has no `package.json`, so pnpm and turbo ignore it, and
Mintlify builds it externally (via its GitHub App) rather than our CI.

## What's here

- **`docs.json`** — the Mintlify config: theme, brand colors, and navigation. The **API reference** tab
  sets `"openapi": "https://api.webhook.co/openapi.json"`, so Mintlify auto-generates the endpoint pages
  and the interactive playground from the **live** spec — no committed copy to drift.
- **`*.mdx`** — the hand-authored guides (introduction, quickstart, authentication) and the per-language
  SDK pages under `sdks/`.
- **`favicon.svg`** — the tab icon.

## Local preview

```sh
cd apps/docs
npx mint dev            # http://localhost:3000
npx mint broken-links   # link check
```

## Deploy

Mintlify deploys via its **GitHub App** on push to `main` (git source: `webhook-co/webhook`, content
directory `apps/docs`) — there is no CI job or marketplace Action here. Because the API reference is
generated from a **remote** spec, a spec change doesn't push git and so won't auto-redeploy the playground;
the CI step that publishes the spec should also `curl -X POST
https://api.mintlify.com/v1/project/update/{projectId}` (Bearer `mint_` admin key) to re-sync it.

## Setup status

- ✅ **GitHub App installed** on `webhook-co/webhook`, deploy branch `main`.
- ✅ **Monorepo content directory** set to `apps/docs`.
- ⏳ **Custom domain** `docs.webhook.co` + Cloudflare DNS (`CNAME docs → cname.mintlify.builders` + the
  Mintlify-issued `TXT` records).
- ⏳ **`mint_` admin key** (only needed for the spec-resync `curl` above).

All of this is free on Mintlify's Hobby tier (custom domain, playground, git sync, MCP, custom CSS/JS).

> **Human verification required.** The rendered site — layout, brand colors, and the API playground — must
> be eyeballed by a human before it's considered live (per the repo's human-UI-testing rule).
