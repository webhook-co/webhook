# What you cannot test locally

Local development is deliberately **hermetic**: no shared credentials, no third-party accounts, works
offline. That buys a lot, and it costs some fidelity. This page is the honest list of what it costs.

It exists because the alternative is worse. A gap nobody wrote down is a gap someone rediscovers at 2am,
usually as "why does this work on my machine and not in production" — or, more dangerously, the reverse.

Every entry says what is different, why it is that way, and what to do if you genuinely need the real thing.

---

## The captcha gate is not exercised

**What runs locally:** the login form renders Cloudflare's published always-pass **test sitekey** on
localhost, so the submit button enables and the magic-link flow works. `TURNSTILE_SECRET_KEY` is unset, so
Better Auth's captcha plugin is **not wired** and nothing is verified server-side.

**Why not just use the test secret key too:** because it breaks login rather than exercising it. Verified
against the live endpoint:

```
$ curl -X POST https://challenges.cloudflare.com/turnstile/v0/siteverify \
    -d secret=<the published always-pass TEST secret> -d response=XXXX.DUMMY.TOKEN.XXXX
{"success":true,"hostname":"example.com","metadata":{"result_with_testing_key":true}}
```

`hostname` comes back as `example.com`, and there is no `action` field. Our plugin pins `allowedHostnames`
(locally `["localhost"]`) and `expectedAction`, so every magic-link send would be **rejected**.

Adding `example.com` to `allowedHostnames` in dev was rejected as a fix: loosening a security control's
configuration to suit development is how that control quietly stops meaning anything.

**If you need to test it:** point a local instance at a real Turnstile widget whose domain list includes
`localhost`, and set the matching real secret.

---

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

## Things that are substituted, not missing

These are hermetic stand-ins. The code path is real; the dependency is not.

| Area | Locally | Flag |
| --- | --- | --- |
| Transactional email | printed to the console, link included | `EMAIL_MODE=log` |
| Social login | only providers with both halves configured are wired; magic link always works | `OAUTH_MODE=optional` |
| KMS / envelope encryption | a process-local KEK from `.dev.vars` | `KMS_MODE=local` |
| Billing | Stripe **test** mode; blank keys mean the plan picker does not render | `BILLING_MODE=test` |

Each mode flag is refused outright if it is ever seen on a deployed Worker, and kept out of every committed
config by `scripts/dev-mode-guard.mjs`.

**To use the real thing:** put real credentials in the app's `.dev.vars` and drop the corresponding flag.
`pnpm dev:secrets` writes a commented template listing exactly which values each app wants.

---

## No seeded events

`pnpm seed` creates users, orgs and endpoints — but **no events**, deliberately.

A captured event's payload lives in R2, and a seeder running in Node cannot write to the local Miniflare
bucket. Seeded events would list correctly and then fail the moment anyone clicked one, which is worse than
an empty list.

**To get events:** `curl` your own local ingest URL. That exercises the real capture path end to end, which
is the thing worth testing anyway.

---

## Cross-worker service bindings

The engine, api and auth Workers call each other over Cloudflare **service bindings** (18 of them). A single
`wrangler dev` session serves one Worker, so a call across a binding has nothing to answer it.

**Status:** a multi-worker dev session is the next piece of orchestration work.

**Today:** each app runs on its own pinned port (see `scripts/dev-ports.mjs`), so anything that talks over
plain HTTP works. Anything that goes over a service binding does not.

---

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
