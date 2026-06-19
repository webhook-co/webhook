# `apps/auth` — auth.webhook.co (co-owned)

A single **Next-on-Workers app** (Next 16 + `@opennextjs/cloudflare`) that serves the identity surface:
the login / consent / device **pages** and the Better Auth runtime + OAuth issuer **route handlers**.
See [ADR-0021](../../docs/adr/0021-opennext-cloudflare-workers-app-and-auth.md) and the Lane C/E build
plans (`internal/build-plans/`).

## Ownership (coordinate edits on the shared scaffold)

- **Lane E** owns the **page tree** (`src/app/(auth)/login | consent | device`) + the **thin scaffold**
  (`layout.tsx`, `globals.css`, `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`, `tsconfig*`,
  `postcss.config.mjs`, `package.json`). This scaffold slice (E2b) stands those up with a placeholder page.
- **Lane C** contributes, *into this app*:
  - the Better Auth runtime + `/api/auth/*` (social + magic-link) → `src/app/api/**`;
  - the OAuth issuer (`@cloudflare/workers-oauth-provider`), `/authorize`, the RFC 8628 device endpoints,
    and `POST /session/exchange` (the `auth.`→`app.` handoff) → `src/app/api/**` / route handlers;
  - the **bindings** in `wrangler.jsonc` (Hyperdrive, `OAUTH_KV`, `KV_AUTHZ`, Secrets-Store secrets — see
    the commented block there);
  - the **OAuth-provider mount**: wrap this OpenNext worker's fetch handler as the Worker's default export
    (gated on the OpenNext composition, confirmed feasible by the E0 spike; see the Lane C plan §9.2).
- **Schema generator (unchanged):** `src/auth.ts` is the **node-context** Better Auth schema-gen config; the
  CI drift guard runs `pnpm auth:generate` against it. It is type-checked under `tsconfig.gen.json` (node),
  separate from the app's `tsconfig.json` (DOM/Workers). Keep `auth.ts` + the `better-auth` / `@better-auth/api-key`
  / `pg` deps intact — the drift guard depends on them.

## Scripts

- `pnpm --filter @webhook-co/auth build` — `next build`.
- `pnpm --filter @webhook-co/auth build:cf` — `opennextjs-cloudflare build` (the workerd bundle).
- `pnpm --filter @webhook-co/auth preview` — build + serve in local `workerd`.
- `pnpm --filter @webhook-co/auth deploy:dry` — build + `wrangler deploy --dry-run`.
- `pnpm --filter @webhook-co/auth auth:generate` — regenerate the Better Auth schema (the drift guard).

The production deploy (the shared OpenNext deploy job co-owned with `apps/web`, + the id/secret overlay) is
finalized with Lane C + the infra owner; no real ids/secrets are committed.
