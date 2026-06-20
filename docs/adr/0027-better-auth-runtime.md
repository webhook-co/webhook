# ADR 0027 — Better Auth runtime: per-request instance, two-driver model, host-only sessions (A1b)

- status: accepted (A1b-1 — the runtime config + mount + the magic-link sender). The signup→bootstrap hook (A1b-2) and the AuthActions client wired into Lane E's LoginForm (A1b-3) extend this ADR.
- date: 2026-06-20
- scope: `apps/auth/src/runtime/{auth,env,magic-link}.ts` + `apps/auth/src/app/api/auth/[...all]/route.ts` + `apps/auth/next.config.ts`. The runtime instance only — distinct from `apps/auth/src/auth.ts` (the generation-only config behind the schema drift-guard, untouched).
- relates: ADR-0010 (auth foundation, r5/r6 — OAuth login mints a scoped key), ADR-0016 (migration: the `webhook_auth` role), ADR-0021 (OpenNext app & auth), ADR-0023 (the app. DAL gate — the sibling pattern), ADR-0024 (Option-B token core that the issuer routes will mount alongside this), `internal/build-plans/lane-c-auth-identity-backend.md` (A1).
- review severity: high (login/session/secret surface)

## context

Lane E shipped the login/consent/device UI shells (mock-first) against frozen action seams. A1b stands up
the runtime that backs them: Better Auth (Google + GitHub social, magic-link email) at `/api/auth/*` on the
co-owned `webhook-auth` Worker (Next-on-`@opennextjs/cloudflare`). Two facts about the target shape this:

1. **workerd has no module-load env.** Bindings (Hyperdrive connection string) and secrets are only
   available per-request via `getCloudflareContext()`. So a module-level `betterAuth()` singleton is
   impossible — the instance must be built per-request.
2. **Better Auth's adapter takes a node-postgres `Pool`**, not the repo's `postgres.js` client (it doesn't
   recognize postgres.js). And it manages the identity tables (`user`/`session`/`account`/`verification`),
   which are RLS-exempt and to which **only the new `webhook_auth` role is granted** (migration 0016 —
   `webhook_app` is ungranted on them, `webhook_authn` is SELECT-only on `api_keys`).

## decision

**1. Per-request instance with explicit pool teardown.** `makeAuth(env)` builds a `betterAuth()` over a
`new Pool(env.HYPERDRIVE_AUTH.connectionString, { max: 1 })` and returns `{ handler, close }`. The route
calls `handler(request)` then schedules `ctx.waitUntil(close())` in `finally` — draining the pool after the
response (never blocking it, never losing a successful response to a teardown hiccup), with a `.catch` that
logs a drain failure rather than dropping it. This relies on the invariant that every handler on this mount
returns a fully-buffered body; a future streamed route here must revisit it.

**2. The two-driver / two-role model.** Better Auth's identity CRUD runs as **`webhook_auth`** via a
dedicated **`HYPERDRIVE_AUTH`** binding — deliberately distinct from the repo's `HYPERDRIVE_AUTHN`
(`webhook_authn`, bearer-verify, SELECT-only). The personal-org bootstrap (A1b-2) is a *separate* path on
`webhook_app` via `HYPERDRIVE_TENANT` (it writes the org/membership domain tables, which `webhook_auth`
can't, and is RLS-policed). Two roles, two Hyperdrive bindings, by least privilege.

**3. Host-only cookie + DB-validated sessions.** No `advanced.crossSubDomainCookies` (the cookie is bound to
`auth.webhook.co`; the `auth.`→`app.` handoff is the backchannel session-exchange A-SX, not a shared
`.webhook.co` cookie — founder X-2). `session.cookieCache.enabled = false` is set **explicitly** (Better
Auth defaults it ON for non-stateful instances) so a revoked session dies immediately.

**4. Magic-link hygiene.** Single-use links, 5-minute expiry, tokens stored **hashed** (`storeToken:
"hashed"` — the DB never holds a usable token); the raw token reaches only the URL Better Auth builds, never
the email sender or a log. Email is sent via the Resend REST API (no SDK) from the verified sender
`login@mail.webhook.co`, with **no click/open tracking** (scanners pre-fetch tracked links and burn the
single-use token).

**5. Fail-closed env + secure-by-default base URL.** `readAuthEnv()` validates every required secret +
Hyperdrive binding at the request boundary (naming a missing key, never its value) instead of a blind cast —
a misconfig is an obvious 500, never an empty-secret session signer. `resolveBaseUrl()` rejects a
non-loopback `http://` `AUTH_BASE_URL` so a bad env can't downgrade the session cookie to insecure.

**6. Runtime config is separate from the gen config.** The runtime enables social + magic-link only; it does
NOT enable Better Auth's organization plugin (org-creation is Lane B's `bootstrapPersonalOrg`, A1b-2) and
does not serve email/password. None of this changes the generated schema, so `src/auth.ts` + the drift-guard
are untouched. `serverExternalPackages: ["better-auth", "pg"]` keeps the node-built-in-using packages
external for the workerd bundle.

## rejected alternatives

- **Module-level `betterAuth()` singleton** — impossible on workerd (no module-load env).
- **`postgres.js` for the Better Auth adapter** — the adapter doesn't recognize it; node-postgres `Pool` is
  required (the rest of the repo's request path keeps postgres.js).
- **Reusing `HYPERDRIVE_AUTHN`/`webhook_authn` for Better Auth** — wrong role (SELECT-only on api_keys; no
  identity-table DML). Hence the new `webhook_auth` + `HYPERDRIVE_AUTH`.
- **Cross-subdomain (`.webhook.co`) session cookie** — would couple auth.↔app.; the session-exchange keeps
  them independent (host-only).
- **`cookieCache` / KV `secondaryStorage` for sessions in v1** — would weaken immediate revocation; v1 is
  DB-validated. (KV may back rate-limiting later — see below.)

## consequences

- **Deferred, tracked as must-fix-before-live: durable magic-link rate-limiting.** Better Auth's built-in
  limiter defaults to IN-MEMORY storage, which is per-isolate on Workers and ineffective fleet-wide — a
  public, email-triggering endpoint needs durable storage (a `rateLimit` DB table or KV `secondaryStorage`)
  + ideally a Turnstile/WAF gate. Deferred to the deploy/bindings slice because the fix needs a KV/DB
  binding and a deliberate session-storage decision, and the endpoint is **not yet deployed** (apps/auth has
  no CD). A code TODO (`auth.ts`) + this ADR + memory track it.
- **Deploy substrate (this slice does NOT wire it):** the `webhook_auth` login password + the
  `webhook-prod-auth` Hyperdrive (migration 0016 already applied to prod), the `HYPERDRIVE_AUTH`/
  `HYPERDRIVE_TENANT` bindings + the Google/GitHub/Resend/`BETTER_AUTH_SECRET` Secrets-Store entries, and
  the apps/auth deploy job — all land with the deploy slice (co-owned with Lane E + infra). `next build` (the
  CI gate) doesn't need them; the route references bindings only by type.
- **Tested** (pure-logic, vitest): the magic-link sender (Resend request shape, no-tracking, no key in the
  error); the config builder (providers from env, host-only cookie, explicit cookieCache-off, magic-link
  plugin present, no email/password, base-URL https-guard); fail-closed `readAuthEnv`; a `makeAuth`
  construct+close smoke test. The full Better Auth instance on workerd + the per-request Pool lifecycle is
  integration-validated by `build:cf`/preview, not unit tests.
- **A1b-3 extends this:** the `AuthActions` client wired into Lane E's LoginForm + the consent decision
  client (A3).

## A1b-2 addendum — signup→bootstrap + secret resolution + the tsconfig boundary

- **Signup→bootstrap.** Better Auth `databaseHooks` provision the user's personal org via Lane B's
  idempotent `bootstrapPersonalOrg` (org + owner membership + default endpoint, deterministic per-user org
  id). It runs on a **separate `webhook_app` postgres.js client** over `HYPERDRIVE_TENANT` (NOT Better
  Auth's `webhook_auth` pool — the two roles have disjoint grants; `bootstrapPersonalOrg` sets the RLS
  tenant context itself). `userId` is Better Auth's server-authenticated id (the committed user/session
  row), never request-derived. The per-user slug carries the full slugified userId as a suffix, so a
  cross-user collision is cryptographically improbable. `user.create.after` is **awaited** (the org must
  exist before signup completes); `session.create.after` is a **self-heal** for the rare user-create
  failure, run **off the login hot path via `ctx.waitUntil`** (a no-op for the already-bootstrapped user,
  so it must not add a tenant-DB round-trip to every login's latency). A failure is logged
  (`String(error)` — never the connection string/pepper/PII) and swallowed, never breaking signup/login.
- **Secrets are Secrets Store bindings (reconciles A1b-1).** The OAuth client id/secret +
  `BETTER_AUTH_SECRET` + `RESEND_API_KEY` + `CREDENTIAL_PEPPER` are resolved per-request via
  `@webhook-co/shared`'s `readSecretBinding` (handles both a `SecretsStoreSecret.get()` and a plain dev
  string), so `makeAuth` is async. `readAuthEnv` presence-checks at the boundary; `resolveAuthSecrets`
  additionally fails closed on an **empty resolved** value (a mis-provisioned store secret) so an empty
  key never signs a session or mints a token.
- **tsconfig node↔workers↔DOM boundary (resolves the deferred phase0-tsconfig friction for apps/auth).**
  apps/auth is the first DOM-lib Next app to import the crypto-bearing workspace packages, whose source
  uses `Uint8Array` where the DOM lib wants `BufferSource`. Per the repo's boundary convention, apps/auth
  consumes `@webhook-co/{db,shared,contract,webhooks-spec}` as **built dist** — tsconfig `paths` map them
  to the extensionless `dist/index` (tsc resolves `index.d.ts` for clean types; turbopack resolves
  `index.js` for the runtime) and they are **dropped from `transpilePackages`** so their source isn't
  re-typechecked under the DOM lib. turbo's `^build` ordering guarantees the dist exists first. (The
  extensionless target — vs the guard's `.d.ts` form — is needed because Next honors `paths` for bundling
  too; apps/auth's mixed DOM/Workers world is unclassified by the boundary guard, so this stays consistent.)
- **Tested** (vitest, 81 in the apps/auth suite): the bootstrap core (slug uniqueness/stability/fallbacks,
  hasher-from-pepper, error-swallow + client close, the awaited primary + the `waitUntil` self-heal);
  secret resolution (string + store `.get()` + empty-resolved fail-closed); the env presence checks. The
  real DB bootstrap is covered by Lane B's `packages/db` tests; the full workerd wiring by `build:cf`.
