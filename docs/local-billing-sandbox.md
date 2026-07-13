# The local Stripe billing sandbox

How to exercise the inbound Stripe receiver (`POST /v1/stripe/webhook`) on your machine, against the
**sandbox** Stripe account, with real Stripe-signed events.

## The thing to understand first

**Localhost does not use a registered Stripe webhook endpoint, and cannot.** A registered endpoint is a
public URL Stripe POSTs to; `http://127.0.0.1` is not reachable from Stripe. Local delivery goes through
the Stripe CLI (`stripe listen`), which holds an outbound connection and forwards events to your port.

That distinction caused a real incident: the sandbox account had a registered endpoint pointing at
**production** `https://api.webhook.co/v1/stripe/webhook`. Production runs `BILLING_MODE=live` with the
**live** signing secret, so every test-mode event failed signature verification (400) — 126 failed
deliveries and a "webhook delivery issues" warning email from Stripe, for events that could never have
been accepted. `stripe listen` is the only correct local path. Don't point a registered endpoint at a
deployed environment running a different `BILLING_MODE`.

Note also that `stripe listen` delivers the account's **default** API version, while a registered endpoint
delivers the version pinned on it (ours pin `2024-06-20`). So the CLI is the stricter test — it is where a
Stripe shape change surfaces first.

## Run it

Three terminals. Everything below is sandbox/test-mode; no real money is reachable.

```sh
# 1 — the local Postgres wrangler dev expects (idempotent; `stop` / `nuke` also available)
pnpm dev:db

# 2 — the API worker
cd apps/api && npx wrangler dev --port 8787

# 3 — forward real sandbox events into it
stripe listen --forward-to http://127.0.0.1:8787/v1/stripe/webhook \
  --events checkout.session.completed,customer.subscription.created,\
customer.subscription.updated,customer.subscription.deleted,invoice.created
```

`apps/api/.dev.vars` already carries `BILLING_MODE=test`, the `sk_test_` key, and the **CLI's** signing
secret (`stripe listen --print-secret`) — not the registered endpoint's. If `stripe listen` ever prints a
secret that differs from `.dev.vars`, update `.dev.vars`; a mismatch shows up as `400 invalid signature`.

## Fire an event

A bare trigger is **ACKed 200 but deliberately not applied**:

```sh
stripe trigger customer.subscription.created
# → 200, logs {"message":"stripe.webhook.unparseable_subscription"}
```

That is correct, not a bug. The receiver resolves the org from `client_reference_id` / `metadata.org_id`
— which *we* set at Checkout — and a synthetic fixture carries neither. An event it cannot attribute to an
org is refused and left **out** of the dedup ledger, so a later fix + replay can still land it.

To exercise the real path, give it an org that exists locally:

```sh
ORG=$(psql "$DEV_DB" -tAc "insert into orgs (id, slug, name)
        values (gen_random_uuid(),'local-sandbox','local sandbox') returning id;" | head -1)

stripe trigger customer.subscription.created --override "subscription:metadata.org_id=$ORG"
```

Now it applies: `200`, a row in `processed_stripe_events`, and the plan mirrored into
`billing_subscriptions` / `orgs.retention_days`.

## Reading the outcome

The receiver is fail-closed, so the status code alone is not the whole story:

| You see | It means |
| --- | --- |
| `503` | Billing is dark — `BILLING_MODE` unset/`off`, or no signing secret. |
| `400 missing/invalid signature` | The secret in `.dev.vars` isn't the one signing the events. |
| `200` + row in `processed_stripe_events` | Applied. |
| `200`, **no** ledger row | Deliberately rejected (no org, unparseable shape) — check the Worker log. |
| `500` | A transient fault; Stripe will redeliver. A malformed `org_id` lands here too. |

## The database

`pnpm dev:db` creates a throwaway loopback cluster in `.dev-pg/` (gitignored) matching every
`localConnectionString` in the wrangler configs, and runs the migrations as the non-superuser
`webhook_owner` — the same way prod does, so RLS still polices the owner and a policy bug can't pass
locally and fail in prod. The roles it must create are **derived** from the wrangler bindings
(`scripts/dev-db-config.mjs`), so adding a binding cannot silently leave the cluster half-provisioned.

This is separate from the test suite's cluster (`packages/db/test/pg.ts`), which spins up per-run on a
random port and is torn down after.
