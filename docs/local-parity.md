# What you cannot test locally

**Local dev is meant to match production** — same code paths, same providers, same class of credential. That
is a hard rule ([`AGENTS.md`](../AGENTS.md)), not an aspiration: real Google and GitHub OAuth, real Resend
delivery, the real Turnstile widget. If a capability ships in prod you should be able to exercise it here.

This page is the short list of places that is not yet true, and it is deliberately short. Every entry says
what differs, **why**, and what to do if you need the real thing.

It exists because the alternative is worse. A gap nobody wrote down is one someone rediscovers at 2am,
usually as "why does this work on my machine and not in production" — or, more dangerously, the reverse.

⚠️ **Before adding an entry here, check the real dependency is genuinely unavailable.** The captcha entry
below was written on sound reasoning and was still wrong: the credential existed the whole time. An entry on
this page is a last resort, not the first thing you reach for.

---

## ~~The captcha gate is not exercised~~ — CLOSED

This used to say the captcha gate could not be exercised locally, on the reasoning that Cloudflare's
always-pass TEST secret returns `hostname: "example.com"` and would be rejected by our `allowedHostnames`
pin. That reasoning was sound; the conclusion was wrong. **The fix was never the test keys — it was the real
widget, which already permitted localhost.**

The `webhook-auth login` widget's Cloudflare-side domain list is `["127.0.0.1", "auth.webhook.co",
"localhost"]`. So the real sitekey solves locally and the real secret verifies those tokens. Local now runs
the same captcha plugin, against the same widget, with the same secret as production:

```
POST /api/auth/sign-in/magic-link  (no token)     → 400 MISSING_RESPONSE
POST /api/auth/sign-in/magic-link  (bogus token)  → 403 VERIFICATION_FAILED
```

Kept here rather than deleted, as a worked example of the failure mode this page exists to prevent: a gap
recorded on good evidence, which was really a substitute nobody had checked was necessary. **Verify that the
real dependency is genuinely unavailable before writing an entry here.**

## RLS is only partly enforced

**14 of the 25** local Hyperdrive bindings connect as the `postgres` **superuser**, and a superuser bypasses
row-level security unconditionally. The other 11 already use their real least-privilege roles
(`webhook_ingest`, `webhook_meter`, `webhook_purge`, and so on).

So a query that would be refused in production by RLS may succeed locally, on those 14 bindings. Tenant
isolation bugs can hide there.

**Status:** repointing the remaining 14 is planned, and it is expected to surface real defects that
superuser access has been masking. That is the point of doing it.

**If you need certainty now:** the `packages/db` integration suite (`packages/db/test/`) runs against a real
Postgres with the real roles, and the nightly RLS job exercises the policies directly.

---

## Marketing site: two routes its worker adds

`apps/www` runs under `next dev` for a fast content loop, but its wrangler `main` is a custom worker
(`worker/index.ts`). `next dev` does not run it, so locally you do not get:

- the cookieless aggregate page-view write to Analytics Engine
- the MTA-STS policy response

Neither blocks content work, which is why www keeps the fast loop. `apps/auth` made the opposite trade —
see below.

---

## What matches prod by default

With the team's credentials in `.dev.vars`, these run exactly as production does — same code path, same
provider, same key:

| Area | Locally |
| --- | --- |
| Social login | real Google + GitHub OAuth (GitHub uses its own dev app; GitHub permits one callback per app) |
| Transactional email | really sends via Resend, from the verified `mail.webhook.co` sender |
| Captcha | the real Turnstile widget and secret — its domain list includes `localhost` |
| Billing | Stripe **test** mode, which is what a non-production environment should use |

### The opt-outs, for contributors with no credentials

An external contributor cannot have any of the above, so each has an explicit escape hatch. **None is the
default**, and each is refused outright if it is ever seen on a deployed Worker
(`scripts/dev-mode-guard.mjs` keeps them out of every committed config):

| Flag | Effect |
| --- | --- |
| `EMAIL_MODE=log` | mail prints to the console, link included, instead of sending |
| `OAUTH_MODE=optional` | providers without both halves configured are not wired; magic link still works |
| `KMS_MODE=local` | a process-local KEK instead of AWS KMS, so endpoints can be created without AWS |

`KMS_MODE=local` is the one that has no alternative today: the engine is the sole KEK custodian and nobody
should hold production AWS credentials to develop. The other two are conveniences, and using them means
accepting that you are not testing what production does.

**Setting them:** put the value in the app's `.dev.vars`. `pnpm dev:secrets` writes a commented template
listing exactly what each app wants and which values are required for parity.

---

## No seeded events

`pnpm seed` creates users, orgs and endpoints — but **no events**, deliberately.

A captured event's payload lives in R2, and a seeder running in Node cannot write to the local Miniflare
bucket. Seeded events would list correctly and then fail the moment anyone clicked one, which is worse than
an empty list.

**To get events:** `curl` your own local ingest URL. That exercises the real capture path end to end, which
is the thing worth testing anyway.

---

## Cross-worker service bindings are ABSENT locally

`apps/web`, `apps/api` and `apps/mcp` reach `apps/auth` and `apps/engine` over Cloudflare **service
bindings** — 18 of them (web 10, api 4, mcp 4). Locally, none of them exist.

Not "exist but can't be answered" — **absent**. The committed wrangler configs carry no `services` block at
all, and that is deliberate rather than an oversight: Cloudflare rejects an *upload* whose service binding
names a Worker that does not exist yet, so committing these would **block a cold deploy** — a fresh
environment brings the Workers up one at a time, and `webhook-web` would be unable to deploy before
`webhook-auth` existed. The bindings are injected only by the deploy overlay
(`scripts/gen-wrangler-prod.mjs`), which runs after the targets are live.

The code is written for that. `env.AUTH_ISSUER` and friends are simply `undefined` locally, each reader
checks structurally before use, and the affected feature degrades rather than the Worker crashing — for
example the MCP server 500s on an opaque (non-`whk_`) token because it cannot reach auth's introspection
entrypoint, while everything else keeps working.

**What this costs you:** anything behind one of those 18 bindings — the auth→app session handoff RPC,
account deletion, connected apps, onboarding, email change, login methods, provider-secret sealing,
delivery dispatch, ingest-URL reveal, cache eviction, payload reads — is not exercisable locally.

**Why a multi-worker `wrangler dev` session is not on its own the fix:** running several Workers in one
session lets a *declared* binding resolve, but there is nothing declared to resolve. Closing this needs the
`services` blocks to exist locally WITHOUT being committed — the cold-deploy constraint above is a
deploy-safety property and must not be traded away for local convenience.

The shape that satisfies both is the one the deploy already uses: a **generated, gitignored config**.
`wrangler.prod.jsonc` is exactly that (see `.gitignore`), so a `wrangler.dev.jsonc` carrying the same
`services` blocks is symmetric with an existing, proven pattern rather than a new deviation.

### Two measured properties of wrangler's dev registry

Both established by experiment against wrangler 4.115.0 (a throwaway caller/callee pair with a named
`WorkerEntrypoint`), not inferred from documentation:

1. **A binding resolves across SEPARATE `wrangler dev` sessions.** Two independently launched sessions find
   each other through the dev registry and RPC works. So this does *not* require one multi-config session —
   which matters, because `apps/web` and `apps/auth` run under the OpenNext preview rather than bare
   `wrangler dev`.
2. **With the target absent, the caller still boots and the binding is still PRESENT.** The call then throws
   `Error: Network connection lost.` at invocation time.

⚠️ **Property 2 is a trap, and it is the reason declaring these locally is not a free win.** Every reader
today checks *structurally* — `if (!env.AUTH_ISSUER) → degrade` — and that check is what makes a
single-app dev session behave sanely. Declare the binding and `env.AUTH_ISSUER` becomes **truthy whether or
not auth is running**, so the guard starts passing and the feature throws instead of degrading. Anyone
running a subset of the apps would be worse off than today.

So the bindings must not be declared until the dev orchestrator starts the whole set together — the
orchestrator is a **prerequisite**, not a parallel nicety.

⚠️ Do not trust wrangler's startup banner as a readiness signal: it prints `Worker … local [connected]` for
the binding even when the target Worker is not running at all.

## `apps/auth` costs you a build step

auth's dev command is the OpenNext preview rather than `next dev`, and that is deliberate. Its wrangler
`main` is a custom worker wrapping the OpenNext handler with the OAuth provider; `next dev` does not run it,
so under `next dev` the **entire issuer surface** — `/session/handoff`, `/session/exchange`, `/token`,
`/authorize` — does not exist and the auth→app handoff cannot complete. It presents as a redirect loop back
to `/login`, which is indistinguishable from a dozen other causes.

A slower server that is correct beats a fast one that silently omits half the surface.

**For pure page work:** `pnpm --filter @webhook-co/auth dev:fast` runs `next dev`. It has no issuer routes,
which is fine as long as you chose it knowingly.

---

## Keeping this page honest

If you add a local substitute, a mode flag, or a dev-only shortcut, add it here. A parity gap that is written
down is a known limitation; the same gap undocumented is a bug report waiting to happen.
