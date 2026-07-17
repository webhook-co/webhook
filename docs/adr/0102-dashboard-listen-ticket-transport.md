# ADR 0102 — dashboard live-events: signed listen-ticket over the WebSocket subprotocol

- status: accepted
- date: 2026-07-05
- note: renumbered from 0101 on rebase — 0101 was taken by the always-shown-ingest-url ADR that merged first.
- scope: `packages/shared` (ticket codec), `apps/engine` (verify + DO echo), `apps/web` (mint action),
  `scripts/gen-wrangler-prod.mjs` (LISTEN_TICKET_KEY overlay)
- review severity: **high** (a new browser-reachable auth path into the tail on the cookieless apex)

## context

The dashboard events list is server-rendered + paginated (no live updates); the CLI `wbhk listen`
streams in real time over the engine's hibernatable `ListenSession` WebSocket DO at `GET /listen` on the
**cookieless** `wbhk.my` apex, authed by an **api-key bearer** (`events.tail`). We want live events in the
browser, reusing that DO — but the dashboard is on `app.webhook.co` (session cookie), the session cookie
must never travel to the cookieless apex, and the **browser `WebSocket` API cannot set an `Authorization`
header**. So the browser needs a session-authorized credential it can present without a header and without
a query-string secret (which would land in logs).

## decision

A **short-TTL (60s) HMAC-signed listen ticket**, minted by a session-authed web action and presented to
the engine via the WebSocket **subprotocol**:

1. **Ticket codec** (`packages/shared/src/listen-ticket.ts`) mirrors the proven MCP session-binding /
   cursor envelope: `<b64url(json)>.<b64url(hmac16)>`, injected clock, returns `null` on any malformed /
   tampered / forged / wrong-key / stale-version / expired ticket (no oracle, never throws). Payload
   carries `{v, o: orgId, e: endpointId, exp}`. New dedicated 32-byte `LISTEN_TICKET_KEY`,
   **byte-identical in web (mint) and engine (verify)**, with a load-loud length guard.
2. **Web mint** (`apps/web/src/server/listen-ticket-actions.ts`): `verifySession()` → RLS-scoped
   endpoint-ownership check (`loadEndpoint`; a cross-org / unknown id is `not_found`, indistinguishable) →
   mint `{orgId, endpointId}`. The ticket is never logged.
3. **Browser → engine**: the browser opens `wss://wbhk.my/listen` offering
   `["wbhk.listen.v1", "ticket." + ticket]`. The ticket rides the `Sec-WebSocket-Protocol` subprotocol,
   **never the URL** (privacy / log hygiene).
4. **Engine verify** (`handleListenUpgrade`): a request with an `Authorization` header keeps the existing
   bearer path; a request with a ticket subprotocol (and no `Authorization`) takes the ticket path —
   **Origin allowlist first** (`https://app.webhook.co`, plus an optional `DASHBOARD_ORIGIN` dev override;
   fail-closed → 403), then HMAC verify (→ 401 on null). A request with neither credential still gets the
   RFC 6750 Bearer challenge (the CLI contract). Both `orgId` and `endpointId` come from the **verified
   ticket**, never the query/headers, then flow to the DO on the existing trusted `x-listen-*` headers
   (the DO's first-bind pinning is unchanged). The raw ticket subprotocol is stripped before the DO hop.
5. **DO subprotocol echo** (`listen-session.ts`): workerd does not auto-negotiate `Sec-WebSocket-Protocol`,
   and a browser aborts if the server accepts none — so the handler threads the accepted token to the DO
   on `x-listen-accept-subprotocol` and the DO sets `Sec-WebSocket-Protocol: wbhk.listen.v1` on its 101.

## amendment (2026-07-17) — org-scope discriminator (v2), for the consolidated events page

The consolidated `/org/{slug}/events` page (org-wide events lane) needs a live tail across EVERY endpoint,
not one. The ticket envelope gains a **required scope discriminator** and bumps to **v2**:

- **Codec**: `{v: 2, o: orgId, s: "org" | "endpoint", e?: endpointId, u?: userId, exp}`. `s` is REQUIRED and
  verify enforces scope↔endpoint agreement: `s:"endpoint"` MUST carry a non-empty `e`; `s:"org"` MUST omit
  `e` (a contradictory envelope is rejected). An absent or unknown `s` returns `null` — **absence never
  grants**, and it can never silently degrade to the broader org scope. This is deliberately NOT the
  additive-optional-`e` shape (which would turn a malformed envelope into an org grant); it is a clean v2
  break so the verifier reads as "unknown scope → null, full stop". The v1→v2 break costs a brief window of
  401→re-mint reconnects during a rolling deploy — fail-closed and self-healing.
- **Web mint**: a new `mintOrgListenTicketAction(slug)` mints `{scope:"org", orgId}` after the session gate
  ONLY — there is **no per-endpoint ownership check** because the ticket names no endpoint. That is sound:
  RLS already scopes every tail read to `orgId`, so an org ticket grants nothing the caller's session did
  not already have.
- **Engine + DO**: org scope skips the endpoint uuid/existence guards, forwards `x-listen-scope` (+ no
  `x-listen-endpoint-id`), and the DO binding is a discriminated union (`endpointId` present iff endpoint
  scope). The reconnect-pinning compares scope + (endpoint only when endpoint-scoped) — an org binding
  stores no endpoint on either side, so it matches itself (avoids a guaranteed 30-min reconnect wedge). The
  tail reads swap to `tailOrgEventsWithCursors` / `orgTailMeta` (no endpoint predicate; RLS the only scope).

## consequences / security posture

- **Least privilege**: an ENDPOINT-scoped ticket grants read-only tailing (`events.tail`) of the ONE
  endpoint it names, for at most 60s. An ORG-scoped ticket (v2) grants read-only tailing of the caller's
  WHOLE org for at most 60s — a wider leaked-ticket blast radius (one endpoint → ≤100), but **zero new
  authorization**: RLS is org-scoped, roles carry no per-endpoint ACL anywhere, and the periodic membership
  re-check is still `(user, org)`. The widening is purely blast radius, bounded by the same 60s TTL +
  30-min lifetime cap. This re-entered the `/security-review` hard gate.
- **No new query-string or header secret**; the session cookie never reaches `wbhk.my`.
- **Reads never bill** (the tail inserts no `events` row) — unchanged metering guardrail.
- The `LISTEN_TICKET_KEY` must be provisioned (32 bytes, byte-identical) in the Secrets Store for BOTH
  engine + web **before** deploy, or the web mints tickets the engine can't verify. Added to both
  `APPS.engine.secrets` + `APPS.web.secrets` in the overlay generator.
- Ships behind the `/security-review` hard gate. The end-to-end cross-origin browser transport is proven
  at Slice-2 prod-verify (the mint + verify halves are fully unit-tested here).
