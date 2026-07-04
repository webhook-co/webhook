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
generated from a **remote** spec, a spec-only change (which lands in `apps/api`, not `apps/docs`) doesn't
touch this directory and so won't auto-redeploy the playground. The remote spec is re-fetched whenever the
docs *do* redeploy: any push touching `apps/docs`, or a manual **Redeploy** from the Mintlify dashboard. An
API-driven resync (`POST https://api.mintlify.com/v1/project/update/{projectId}` with a `mint_` admin key)
exists but the admin key is a **paid Enterprise** feature, so we don't rely on it — a manual redeploy after
a spec change is the Hobby-tier path.

## Setup status

- ✅ **GitHub App installed** on `webhook-co/webhook`, deploy branch `main`.
- ✅ **Monorepo content directory** set to `apps/docs`.
- ✅ **Custom domain** `docs.webhook.co` — live (Cloudflare `CNAME docs → cname.mintlify.builders`,
  Mintlify-issued `TXT` verification, TLS via Let's Encrypt).
- ➖ **`mint_` admin key** — not used; the API-driven spec-resync it gates is Enterprise-only. Redeploy
  manually from the dashboard after a spec change instead.

All of the above is free on Mintlify's Hobby tier (custom domain, playground, git sync, MCP, custom CSS/JS).

> **Human verification required.** The rendered site — layout, brand colors, and the API playground — must
> be eyeballed by a human before it's considered live (per the repo's human-UI-testing rule).
