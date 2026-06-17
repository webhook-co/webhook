# Deploy: `apps/www` → www.webhook.co (Workers Static Assets)

The marketing site is a static export (`output: "export"` → `apps/www/out/`) served by an
**assets-only** Worker (`webhook-www`) — no Worker script, no bindings. Config lives in
`apps/www/wrangler.jsonc`; caching/security headers ship in `apps/www/public/_headers` (copied into
`out/`). Ongoing deploys are automated by `.github/workflows/deploy-www.yml`.

## One-time zone setup (human-reviewed — touches the webhook.co zone)

Order matters: prove `www.` before touching the apex, so the live `api.`/`mcp.` routes are never at
risk. Run under explicit prod authorization for the session.

1. **First deploy** creates the worker: `pnpm --filter @webhook-co/www build && pnpm --filter
   @webhook-co/www exec wrangler deploy` (reads `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   from the env). With `workers_dev: false` and no routes, the worker exists but is not yet publicly
   routed — nothing is live.
2. **Bind the custom domain** `www.webhook.co` to `webhook-www` (Workers → custom domain, or a
   proxied DNS record for `www` + a route). Verify `https://www.webhook.co/` serves the homepage,
   assets load, and interactivity works (not just HTTP 200).
3. **apex → www 301**: a zone **Single Redirect Rule** on `webhook.co` — `http.host eq "webhook.co"`
   → `https://www.webhook.co${http.request.uri.path}`, status **301**, preserve query. Enable
   **Always Use HTTPS**. Exact-host match → does **not** touch `api.`/`mcp.`. (Not `_redirects` —
   that's path-only and can't match a host. Creating the rule may need a Zone *Rules → edit* token
   scope; add it if the write 403s.)
4. **HSTS** ships in `_headers` (www-only, `max-age=63072000`, **no** `includeSubDomains`/`preload`)
   — the zone-wide HSTS toggle is **not** used, because this zone also fronts `api.`/`mcp.`.

## Ongoing CD

`deploy-www.yml`: push to `main` touching `apps/www/**` or `packages/ui/**` rebuilds and runs
`wrangler deploy` (refreshes assets only — routing is untouched). PRs run `wrangler deploy
--dry-run` + the `check:export` artifact guard. Needs repo secrets `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`. The org blocks third-party Actions, so it calls `wrangler` directly (root
devDep) — no `cloudflare/wrangler-action`.

## Verify

- `curl -sI https://www.webhook.co/` → 200 + security headers + HSTS (no `includeSubDomains`).
- `curl -sI https://webhook.co/` → 301 → `https://www.webhook.co/` (single hop, query preserved).
- `curl -sI https://www.webhook.co/_next/static/<hash>` → `immutable` cache header.
- Unknown path → 404 (`out/404.html`), CSP present **and** the page is interactive.
- `api.webhook.co` + `mcp.webhook.co` still healthy (no regression).

## Rollback

`wrangler rollback` (or redeploy the prior version) for the worker. The custom domain + redirect
rule are independent of the worker version, so a content rollback never disturbs routing.
