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

## ~~RLS is only partly enforced~~ — CLOSED

**All 24 local Hyperdrive bindings now connect as their real least-privilege role.** None is a superuser,
and `scripts/dev-superuser-guard.mjs` (wired into `lint`) keeps it that way — it discovers the bindings from
the wrangler configs rather than a hand-kept list, so a binding added later is covered automatically.

This used to be 13 bindings connecting as `postgres`, and a superuser bypasses row-level security
unconditionally. Measured on the local database, same query, same data:

```
as postgres     (the old binding) → 3 endpoints across 3 orgs   ← every tenant
as webhook_app  (the new binding) → 1 endpoint  per org context ← correctly isolated
                without any tenant context → 0 rows
```

So local dev really was reading across every tenant, and a query production would refuse succeeded here —
and in CI. That is the failure this page exists to record: not a missing feature, but a **silent** one.
A missing service binding fails loudly at call time; a superuser binding fails by *permitting* something,
so nothing ever draws attention to it.

The roles were already there — migration 0002 creates `webhook_app`, `webhook_authn` and the rest as
`login nosuperuser nobypassrls` — and `scripts/dev-db.sh` verifies whatever role the bindings ask for, so
repointing them needed no new provisioning.

---

## ~~apps/web runs without its service bindings~~ — CLOSED

**`pnpm dev` now runs apps/web under the OpenNext preview with all 10 service bindings.** It used to run
`next dev`, and `next dev` is not wrangler: it takes no `-c`, so it cannot carry a service binding at all.

That mattered more than "a binding is missing", because the readers **degrade rather than throw**.
`exchangeTicket()` prefers the `AUTH_SESSION_EXCHANGE` RPC and quietly falls back to a public
`POST /session/exchange` when unbound — a route that exists *only* for local dev and preview, and is
retired to a 404 on the prod host. So the default local login exercised a transport production never uses,
and produced exactly the same redirect either way.

Measured with the same bogus ticket against the same auth worker, watching auth's request log:

```
pnpm dev      (bindings)  → auth received 0 HTTP requests   ← redeemed over the RPC
pnpm dev:fast (next dev)  → auth received POST /session/exchange 401   ← the fetch fallback
```

Identical `307` to the caller both times. Nothing in the UI, the logs, or the status code distinguished
them — which is precisely why it survived this long.

The cost is fast refresh, so it is kept one command away: **`pnpm --filter @webhook-co/web dev:fast`** for
pure UI work, where no binding is in the path. Anything touching login, endpoints, or delivery wants the
default. `apps/www` keeps `next dev` outright — it has no service bindings, so the preview would cost the
fast loop and buy nothing.

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
| Google One Tap | the real Google Identity Services prompt, keyed by the same `GOOGLE_CLIENT_ID` binding as the button — **but only if your OAuth client lists your local origin under *Authorized JavaScript origins*** (see below) |
| Billing | Stripe **test** mode, which is what a non-production environment should use |

### The opt-outs, for contributors with no credentials

An external contributor cannot have any of the above, so each has an explicit escape hatch. **None is the
default**, and each is refused outright if it is ever seen on a deployed Worker
(`scripts/dev-mode-guard.mjs` keeps them out of every committed config):

| Flag | Effect |
| --- | --- |
| `EMAIL_MODE=log` | mail prints to the console, link included, instead of sending |
| `OAUTH_MODE=optional` | providers without both halves configured are not wired; magic link still works — and with Google unwired, **no Google script loads on the login page at all** |
| `KMS_MODE=local` | a process-local KEK instead of AWS KMS, so endpoints can be created without AWS |

`KMS_MODE=local` is the one that has no alternative today: the engine is the sole KEK custodian and nobody
should hold production AWS credentials to develop. The other two are conveniences, and using them means
accepting that you are not testing what production does.

**Setting them:** put the value in the app's `.dev.vars`. `pnpm dev:secrets` writes a commented template
listing exactly what each app wants and which values are required for parity.

**Getting the shared credentials onto a new machine.** Most values need no sharing: the `generated` ones
are random per machine and the `local` ones are non-secret literals already in the committed examples. What
is left is 11 real third-party credentials — the Google and GitHub OAuth pairs, Resend, Turnstile, and the
Stripe test-mode values. **Nine of them** travel in the vault below; two are fetched per machine, for two
different reasons given after it.

Those live **encrypted** in the private `internal` repo, via sops + age:

```
pnpm dev:secrets:vault --init     # once, ever: make the keypair, wrap it with a passphrase
pnpm dev:secrets:vault --unlock   # once per machine: unwrap the key here
pnpm dev:secrets:vault --push     # encrypt your local credentials into internal
pnpm dev:secrets:vault --pull     # decrypt them into every app's .dev.vars
```

Encrypted rather than a plain file in a private repo for a specific reason: GitHub secret scanning runs on
this org with push protection on, and vendors participate in that programme — so committing a live key can
get it revoked **by the vendor**. A production incident caused by a convenience commit. Ciphertext is the
only form git should ever see.

**Two credentials are deliberately NOT in the vault**, and `--push` prints both reasons every run rather
than leaving you to discover them. `scripts/dev-secrets-vault.mjs` refuses to carry them in *either*
direction, and `pnpm dev` still fails loudly if either is missing.

| Not shared | Why |
| --- | --- |
| `RESEND_API_KEY` | **Blast radius.** It is the same key production sends with. This vault's protection is a passphrase, and repo read access yields the ciphertext and the wrapped key together — so the passphrase is the only thing between a repo reader and a production capability, attackable offline. Fine for a Stripe *test-mode* key or an OAuth client whose callbacks are `localhost`; not fine for something that can send mail as webhook.co. Compliance-by-design puts production secrets in a KMS, not an offline-attackable git blob. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | **Machine scope.** A registered Stripe endpoint POSTs to a public URL and can never reach localhost, so the local receiver is fed by the CLI's tunnel and `.dev.vars` holds the CLI's *own* `whsec_` (`stripe listen --print-secret`). Sharing one machine's value hands every other machine a secret its own `stripe listen` will never mint — `400 invalid signature`, with nothing pointing at the cause. |

The second is the same shape as the `STRIPE_METER_EVENT_NAME` bug: a value that merely *looks* global. When
adding a name, "is it a secret" is the wrong question — ask **what it opens**, and **whether it is the same
value on every machine**.

> ⚠️ **`sops` does not look where you think it does.** It resolves its default age key path with Go's
> `os.UserConfigDir` — `~/Library/Application Support/sops/age` on macOS, `~/.config/sops/age` on Linux.
> This script writes the key to one path everywhere, so it passes `SOPS_AGE_KEY_FILE` explicitly. Without
> that, `--pull` failed on macOS with *"identity did not match any of the recipients"* — a message that
> accuses the key of being wrong when it was merely somewhere else.

The age **public** key is a recipient and lives in `internal/.sops.yaml`. The **private** key is wrapped
with a passphrase and committed alongside it, so everything is in the one repo and the only thing carried
between machines is a passphrase.

⚠️ That means repo read access yields both the ciphertext and the wrapped key, so the passphrase is doing
all the work — five or six random words, and nothing typed anywhere else.

**`pnpm dev` refuses to start without them.** `scripts/dev-preflight.mjs` runs first and fails loudly,
naming every missing value, if an app has no `.dev.vars` or leaves a parity-required credential blank.

This exists because the alternative was silent. A clone with no `apps/auth/.dev.vars` started perfectly
happily and served a login page that rendered correctly and simply offered fewer ways in — the page
derives its social buttons from which OAuth secrets are *present*, so absent credentials just meant absent
buttons. Nothing errored, so nothing said so. That is the failure this repo's fence pattern explicitly
forbids: **flags are explicit, never inferred from a missing secret.** The page was inferring.

Setting one of the flags above is how you opt out, and that is the point — the flag is an
acknowledgement. The difference that matters is between *choosing* a degraded local stack and not
noticing you have one.

---

## Firing a cron locally

`pnpm cron <job>` invokes a scheduled Worker's **real** `scheduled()` handler — `pnpm cron --list` shows
all 20 jobs. Cron work previously had no local trigger at all: you could read the handler, or wait an hour.

It works through `wrangler dev --test-scheduled`, which exposes `/__scheduled?cron=<expr>`. That is the same
entry point Cloudflare calls, reached over HTTP — no fake transport and no mode flag, which is what makes it
parity rather than a substitute. Every app declaring a cron now runs with that flag, discovered from the
committed triggers so a newly scheduled Worker cannot be silently unreachable.

**A cron EXPRESSION is what Cloudflare schedules, not a job.** `apps/engine` fans 14 jobs out of its hourly
tick, so firing any one of them fires all 14. The command resolves a job to its tick, fires it, and prints
what else that tick runs rather than implying an isolation that does not exist:

```
⏰ anchor — firing engine's "0 * * * *" tick
   that tick ALSO runs: activation-rollup, delivery-stats-rollup, event-payload-purge, …
```

Only `cap-producer` is genuinely alone, on the 5-minute tick. Job names are the `beat` identifiers
`scripts/cron-dispatch-guard.mjs` already pins, so they cannot drift into a second vocabulary.

---

## No seeded events

`pnpm seed` creates users, orgs and endpoints — but **no events**, deliberately.

A captured event's payload lives in R2, and a seeder running in Node cannot write to the local Miniflare
bucket. Seeded events would list correctly and then fail the moment anyone clicked one, which is worse than
an empty list.

**To get events:** `curl` your own local ingest URL. That exercises the real capture path end to end, which
is the thing worth testing anyway.

---

## Cross-worker service bindings — api and mcp done, web still absent

`apps/web`, `apps/api` and `apps/mcp` reach `apps/auth` and `apps/engine` over Cloudflare **service
bindings** — 18 of them (web 10, api 4, mcp 4).

**api and mcp now have theirs locally (8 of the 18).** `scripts/gen-wrangler-dev.mjs` writes a gitignored
`apps/<app>/wrangler.dev.jsonc` — the committed config plus the bindings — and each app's `dev` script
passes it with `-c`. `pnpm dev` regenerates it before starting anything.

They are not simply committed because Cloudflare rejects an *upload* whose service binding names a Worker
that does not exist yet: committing all 18 would **block a cold deploy**, since a fresh environment brings
the Workers up one at a time and `webhook-web` could not deploy before `webhook-auth` existed. A generated,
gitignored overlay keeps that deploy-safety property and still gives local dev the bindings — the same
shape the deploy itself uses for `wrangler.prod.jsonc`.

`wrangler dev` resolves a binding across **separate** dev sessions through its dev registry, keyed on the
target's config `name`. That is why `pnpm dev` starting every app matters.

**`apps/web`'s 10 need `pnpm --filter @webhook-co/web dev:bindings`.** web runs under `next dev`, which is
not wrangler and takes no `-c` — so an app running that way *cannot* have a service binding at all. Its
`dev:bindings` script runs the OpenNext preview instead, against the same generated overlay, and all 10
resolve (verified with `wrangler types`; it boots in ~16s and serves).

It is **opt-in rather than the default**, and that is a judgement worth stating rather than burying. The
preview has no fast refresh: every change needs a rebuild. web is the app people iterate on most, so making
that the default would tax every dashboard change to fix a gap that matters on a minority of them.
`apps/auth` made the opposite call because under `next dev` its entire issuer surface does not exist —
unusable, not merely reduced.

⚠️ The honest cost of that choice: under plain `next dev` the 10 bindings are absent, and the readers check
structurally and **degrade** rather than throwing. That is silent. If you are touching the session handoff,
account deletion, connected apps, onboarding, email change, login methods, provider-secret sealing, delivery
dispatch, ingest-URL reveal or cache eviction, use `dev:bindings` — the fast loop will quietly do less.

**What is verified, and what is not.** `wrangler types -c wrangler.dev.jsonc` resolves all four bindings for
each of api and mcp, and starting the engine flips them from `[not connected]` to `[connected]`. An
end-to-end RPC call through a binding has **not** been exercised yet — it needs an authenticated route and
seeded data. Treat the bindings as declared and linked, not as proven answerable.

⚠️ Two traps worth knowing. A declared binding whose target is **not running** still lets the caller BOOT:
the binding is present and the call throws `Network connection lost` only when made, so a reader that checks
structurally (`if (!env.AUTH_ISSUER) degrade`) starts passing that check and then throws. And wrangler
prints the binding table **once at startup** — `[connected]` there is a point-in-time render, not a live
readiness signal.

### Google One Tap needs a *second*, easily-missed allowlist

"Authorized JavaScript **origins**" is a different list from "Authorized **redirect URIs**" in the Google
Cloud console, and One Tap is gated on the first while the "Continue with Google" button is gated on the
second. So a contributor with a working Google OAuth app — button signs in fine — can still get no One Tap
prompt, and the only signal is an `unregistered_origin` message in the browser console. No request fails, no
test goes red, and the page looks exactly as it should minus the prompt.

If you are running your own Google OAuth app and want One Tap locally, add `http://localhost:3001` (and
`http://127.0.0.1:3001` if you use that spelling) to **Authorized JavaScript origins**. If you would rather
not, nothing breaks: every other way in still works, and One Tap simply does not appear. This is a genuine
local/production deviation and is recorded here rather than glossed — the deployed origin
`https://auth.webhook.co` is on that list, so production shows the prompt where your machine may not.

A second, milder deviation: One Tap also requires `GOOGLE_CLIENT_ID` to be shaped like a real Google client
id (`<project-number>-<random>.apps.googleusercontent.com`). A free-text placeholder satisfies the social
buttons, which only test PRESENCE, but turns One Tap off. That guard exists so a mis-bound client SECRET can
never reach the page, and it means "my buttons render but One Tap doesn't" is usually a placeholder id.

---

## Keeping this page honest

If you add a local substitute, a mode flag, or a dev-only shortcut, add it here. A parity gap that is written
down is a known limitation; the same gap undocumented is a bug report waiting to happen.
