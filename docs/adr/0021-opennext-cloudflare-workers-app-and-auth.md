# ADR 0021 — the app. dashboard and auth. pages render on Cloudflare Workers via OpenNext

- status: accepted
- date: 2026-06-19
- scope: `apps/web`, `apps/auth`
- supersedes: the **hosting** decision in [ADR-0001](0001-web-and-design-system-stack.md) (Next.js on
  Vercel) for `apps/web`. ADR-0001's design-system home + stack (Tailwind v4, shadcn-style Radix + `cva`
  primitives, Motion, Vitest, `@webhook-co/ui`) is unchanged.
- relates: ADR-0010 (auth foundation, internal r5–r7); the Lane E build-plan (`internal/build-plans/`).

## context

`app.webhook.co` (the dashboard) and `auth.webhook.co` (login / consent / device pages) are **dynamic,
auth-gated** Next.js surfaces — unlike `apps/www`, which is a static export. ADR-0001 pinned the dashboard
to **Vercel**. The founder reversed that for the auth-foundation epic: the rest of the platform (engine,
api, mcp, Hyperdrive, R2, KMS, the realtime `/listen` Durable Objects) is **all on Cloudflare**, and the
constitution weights **sub-processor minimization, region pinning, and a single-vendor data story**. A
primary-source platform review found Cloudflare the better fit on those axes (proximity to the all-CF data
plane, realtime via Durable Objects, one CD / one secrets surface / no egress), with Vercel winning only
Next-feature parity and adapter maturity — neither decisive once the auth seam is de-risked.

The one real risk was whether an auth-gated Next 16 app runs correctly on Workers via OpenNext. A
throwaway **E0 spike** retired it (below).

## decision

Render and deploy both surfaces with **Next.js 16.2.9 on Cloudflare Workers via `@opennextjs/cloudflare`
1.19.11** (`wrangler` ≥ 4.86; `nodejs_compat`).

- **Gate auth with the Data-Access-Layer pattern, not middleware.** `@opennextjs/cloudflare` does not
  support Next 16's `proxy.ts`/Node-middleware (upstream `opennextjs/cloudflare#1277`). The gate is a single
  `verifySession()` that reads the host-only session cookie via `cookies()` in server components / route
  handlers / server actions, behind a `server-only` boundary — which is **what Next 16 itself recommends**
  for auth, so nothing is lost.
- **No incremental-cache infrastructure.** Both apps are pure SSR (no ISR / `use cache`), so
  `defineCloudflareConfig({})` is empty — no R2 cache bucket, DO queue, or D1 tag cache.
- **`apps/web` is E-sole-owned; `apps/auth` is a co-owned OpenNext app** — Lane E owns the page tree + the
  thin scaffold (`layout`, `next.config`, `open-next.config`, `wrangler`), Lane C mounts the Better Auth
  runtime + the OAuth issuer + the `/authorize` / device / `/session/exchange` route handlers into it.

## the E0 de-risking spike (evidence)

A minimal OpenNext app (a `cookies()`-gated server-component route + a server action) was built and run in
**local `workerd`** (`opennextjs-cloudflare build` → `wrangler dev`):

- `opennextjs-cloudflare build` compiled Next 16.2.9 + bundled the worker (`.open-next/worker.js`).
- The gated route returned **307 → `/login`** with no cookie and **200** with the session cookie present —
  i.e. `cookies()` in a server component works in `workerd`; the documented footgun did not manifest with
  the DAL pattern.

So the Vercel fallback is not triggered. (Two items live in adjacent slices, not here: the
`@cloudflare/workers-oauth-provider` × OpenNext composition on `apps/auth` is validated by Lane C; the
nonce-based CSP is asserted when the rendered shell lands.)

## consequences

- `apps/web` gains `open-next.config.ts` + `wrangler.jsonc` + `build:cf`/`preview`/`deploy:dry` scripts; the
  repo-wide gate (`build` = `next build`) is unchanged, and `build:cf` is a separate, opt-in build.
- The **production deploy** (an OpenNext build→deploy job + the id/secret overlay for the Hyperdrive
  `webhook_app` pool, the shared `KV_AUTHZ`, and the `CREDENTIAL_PEPPER`/`AUDIT_CHAIN_HMAC_KEY` Secrets-Store
  bindings) is coordinated with Lane C and the infra owner; those credential bindings land with the
  credential-management slice, not the bare runtime.
- **Next-17 forward dependency:** the adapter's Node-middleware (`proxy.ts`) support is unscheduled. Because
  the gate lives in server functions (not middleware), a future deprecation of the legacy `middleware.ts`
  path cannot break it; track the adapter's node-middleware API before adopting Next 17.
- A `pnpm` workspace dev dependency (`@opennextjs/cloudflare`) is added to `apps/web` only; it is Apache-2.0
  and does not cross into `ee/`.

### checklist for the credential-management + deploy slices (E6 / CD)

- **`run_worker_first` vs static assets:** by default Workers serve static assets *ahead of* the Worker, so
  the DAL gate only protects routes the Worker handles. When the gated dashboard routes land, verify no
  gated path is asset-shadowed (or scope `run_worker_first` to the gated segments).
- **CI coverage:** the repo gate's `build` is `next build`; it does **not** exercise `build:cf`
  (`opennextjs-cloudflare build`). Wire the OpenNext build into CI with the deploy job so a workerd-only
  regression (a `server-only` import, a workerd-incompatible dep) is caught before deploy.
- **`serverExternalPackages`:** add `["jose", "postgres"]` when the session JWT + the Postgres driver are
  imported (E6/E7), so Next bundles their workerd export path.
