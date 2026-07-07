# ADR 0105 — wbhk.my bare root 302-redirects to the marketing homepage

- status: accepted.
- date: 2026-07-07
- scope: `apps/engine` (the `handleFetch` router — the bare-apex `GET /` branch and a new
  `GET /healthz`). No migration; no route/binding change; no Cloudflare zone change.
- relates: [0085](0085-ingest-accept-all-verbs-method-liveness.md) (accept-all-verbs + the per-token
  browser liveness that this leaves untouched), and the cookieless-ingest-apex constitution (`AGENTS.md`).

## context

`wbhk.my` is the cookieless webhook-ingest apex: `wbhk.my/{token}` is the path-token ingest write path,
`/listen` is the CLI tunnel, and unknown tokens 404. The **bare root** `GET https://wbhk.my/` returned a
plaintext `200 "webhook:engine ok"` liveness probe — so a human who pasted the bare domain into a browser
saw a cryptic internal string, and (unlike the per-token liveness at `ingest.ts` `LIVENESS_HEADERS` and the
handshake response) that root response carried **no** `x-robots-tag: noindex` / `referrer-policy`, leaving the
ingest apex crawler-indexable and echoing the internal service name.

We want a human landing on the bare apex to reach the product, not a debug string — while the ingest surface
stays byte-for-byte unchanged and absolutely reliable.

## decision

In the engine router (`apps/engine/src/index.ts` `handleFetch`), the **bare root only**:

- `GET /` → **302** redirect to `https://www.webhook.co/` (the canonical marketing homepage), with
  `x-robots-tag: noindex` + `referrer-policy: no-referrer`.
- `GET /healthz` → **200 `ok`** (also `noindex`) — a dedicated machine liveness probe, since the root was
  previously the engine's only one (matches the MCP worker's `/healthz` house convention).

Everything below is untouched: `/listen`, the method gate, the `looksLikeCredential` token pre-filter, and
`handleIngest`. Non-`GET` `/` still 404s. `/{token}` ingest and `telemetry.wbhk.my` are never matched.

**Why in the worker, not a Cloudflare zone Redirect Rule.** A `http_request_dynamic_redirect` rule *would*
preempt the custom-domain worker and keep the ingest bundle unchanged — but it carries a catastrophic failure
mode: a mis-scoped expression (`starts_with "/"` instead of `path eq "/"`) silently 301s **every inbound
webhook** to marketing = total ingest data loss, and the repo has no redirect IaC today (so it would be
untested click-ops that drifts). In worker code the exact-path match sits beside the unit-tested ingest gate
and **cannot** swallow a token; the change is TDD-covered, atomic with the normal engine deploy, and
reversible. That structural immunity to ingest loss outweighs keeping the worker bundle byte-identical.

**Why 302, not 301.** A 301 is cached by browsers/proxies ~indefinitely and is effectively irreversible; its
only upside (SEO link-equity consolidation) is moot because `wbhk.my` should be noindexed anyway. 302 keeps
the root's behaviour reversible; promote to 301 only if the redirect is ever confirmed permanent.

## consequences

A browser hitting `https://wbhk.my/` lands on `www.webhook.co`; the ingest apex is no longer indexable and no
longer leaks the internal service name at its root. Ingest, tunnel, handshake, and per-token liveness are
unchanged — the isolation is locked by an anti-regression test asserting `/{token}` is never redirected. The
engine keeps a machine liveness probe at `/healthz`. No migration, no binding/route change, and no Cloudflare
zone/DNS change — so no click-ops and nothing for an operator to drift. If a `wbhk.my` zone Redirect Rule is
ever added later, it must be scoped `http.host eq "wbhk.my" and http.request.uri.path eq "/"` (path *equals*,
never `starts_with`) to avoid swallowing `/{token}`.
