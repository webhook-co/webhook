# ADR 0085 — Ingest accepts all verbs: record the method, per-token liveness, capture-all posture

- status: accepted.
- date: 2026-06-30
- scope: `apps/engine` (the `wbhk.my` ingest hot path) + `packages/db` (the `events.method` column, migration
  0027) + `packages/shared`/`packages/contract` (the `method` field on the event-detail schema). S8 Slice 1.
- relates: [0013](0013-ingest-durability-ordering.md) (the no-drop / durable-before-ACK floor this preserves),
  [0079](0079-slack-url-verification-handshake.md) (the pre-capture handshake pattern the liveness branch
  mirrors; its "GET handshakes for other providers remain a 405" line is superseded here), [0006](0006-metering-derived-soft-cap-pause.md)
  (metering is derived from `events` rows; the soft cap pauses, not bills).

## context

The ingest endpoint was **POST-only**: any other verb got `405 + Allow: POST`, checked *before* token
resolution so the rejection leaked no token validity. Two gaps followed: (1) a paste-in-browser GET to a
live ingest URL returned a scary `405` rather than a friendly "this endpoint is live"; (2) the GET
verification-handshake class (Meta `hub.challenge`, X/Twitter CRC, Dropbox, eBay, Adobe) — which a sender
fires to confirm a subscription — was hard-blocked, so those senders could never complete setup against a
`wbhk.my` URL. The dominant request-inspection norm is the opposite: accept every verb and record the
method.

This ADR makes the ingest endpoint accept **all** standard verbs, record the HTTP method as a first-class
field of the captured request, and answer a per-token `GET`/`HEAD`/`OPTIONS` with a friendly liveness
response. The per-provider GET challenge dispatcher itself is a follow-up slice; this slice lays the verb
routing, the recorded method, and the liveness surface it sits on.

## decision

**1. Accept all standard verbs; reject the rest before resolution.** `GET, HEAD, OPTIONS, POST, PUT, PATCH,
DELETE` are accepted. A non-standard verb (e.g. `TRACE`) is rejected `405` with the full `Allow` list, and
that gate stays **before** token resolution — so a rejected verb is answered uniformly whether or not the
token exists, preserving the original no-token-validity-oracle property for the verbs we still reject.

**2. Record the method.** `events.method text` (migration 0028, nullable) records the captured verb. It is a
**fact** column (like `verified`/`provider`), never a billing verdict. Legacy rows captured under the old
POST-only gate report `NULL` ("unrecorded") rather than an inferred `'POST'`. The method surfaces read-only
on event detail (`events.get`) at CLI/API/MCP/web parity via the shared event schema; it is deliberately
**not** on the lean event-summary schema, whose `wbhk listen` tunnel frame is parsed leniently and would
silently drop frames if a required field were added under producer/consumer version skew.

**3. Capture every verb; vary only the success response.** Every accepted verb flows through the existing
capture path (the no-drop / durable-before-ACK floor is unchanged: the body is durable in R2 before the
metadata row, before any ACK). Only the success *response* varies: write verbs get the terse `200 "ok"`;
`GET` gets a constant browser-facing liveness body; `HEAD` a 200 with no body; `OPTIONS` a `204` with no
`Access-Control-*` (`wbhk.my` stays no-CORS — we do not answer preflight). The liveness response is built
from a **constant** — it reflects nothing resolved (no endpoint id, org, name, paused flag, count, or
captured payload). A **paused** endpoint answers a liveness verb with that *same* constant 200 (and
captures nothing), so the paused/active distinction is **not** observable via a GET/HEAD/OPTIONS; only a
write verb surfaces paused (a retryable 429), exactly as POST always has. So a liveness verb leaks only the
same token-existence signal the capture path already does (a known token → 2xx vs an unknown token → 404),
never a finer oracle. All now-browser-facing responses carry `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex`, and `X-Content-Type-Options: nosniff`.

**4. Metering posture: every captured request is a billable event, disclosed.** Usage is derived by counting
captured `events` rows (ADR-0006), so accepting all verbs means every captured request — including
non-delivery traffic — is a billable event. This is a deliberate, **disclosed** posture: it stays
**single-dimension** (no per-step counting), the ceiling **pauses + alerts** rather than billing past it,
and the posture is surfaced at endpoint creation and on the pricing page. So billing remains transparent and
predictable — "no bill-shock" is delivered by disclosure + alerts + pause, not by silently excluding
traffic. The captured-and-billed *row* footprint of repeated non-delivery traffic is naturally bounded:
identical-body requests (e.g. repeated liveness/unfurl/crawler `GET`s) collapse under the content-hash
dedup (`ON CONFLICT (endpoint_id, dedup_key) DO NOTHING`) to roughly one row per dedup window. The dedup
key for that strategy now folds in the HTTP **method** (`<method>:sha256(body):bucket`), so the collapse is
**per verb** — a liveness `GET` flood is still ~1 row/window, but a non-delivery verb can never dedup-suppress
a real empty-body `POST` of a *different* verb (the no-drop floor holds across verbs). Note the per-request
R2 PUT + DB upsert still run *before* the `ON CONFLICT` short-circuit, so bodyless probe volume drives I/O
even though it collapses to one billable row; that raw volume is bounded by edge abuse-rate-limiting (a
control outside this change), the same way the POST path already is. **The meter/overage/pause wiring itself
is out of scope** (a later slice) — this slice lays the posture the meter will consume.

## consequences

- A `wbhk.my` URL pasted in a browser now answers "this endpoint is live" instead of a `405`, and every verb
  is captured with its method recorded — the inspector model. This is the foundation the GET
  verification-handshake dispatcher (Meta/X/Dropbox/eBay/Adobe — a follow-up slice) sits on; until then a
  challenge GET is captured + answered with plain liveness, not yet echoed.
- The token-existence signal is unchanged in kind from the POST path (a known token has always answered
  differently from an unknown one); ingest tokens are high-entropy CSPRNG, so enumeration stays infeasible.
  Dropping the 405 does route non-delivery traffic into token resolution; the edge rate-limit/flood-shield
  remains the volume control.
- Recording the method costs one nullable column and a backward-compatible `ingest_event` signature change
  (the new parameter is appended last, so existing positional callers are unaffected); the function change
  is reversible (the migration restores the prior definition on `down`). **Deploy ordering: apply the
  migration before the read code ships** — `getEvent` selects `method`, which 500s until the column exists;
  the appended-default arg keeps the *prior* engine's `ingest_event` calls valid during the gap, so
  migrate-first is safe in both directions. The read field is `nullable().optional()` so a newer CLI/MCP
  parsing an *older* api's response (which omits `method`) tolerates the cross-version skew.
- The "no metering bill-shock" posture is **refined, not removed**: single-dimension and pause-not-bill are
  intact; what broadens is the definition of a billable "event" to "any captured request", made transparent
  by disclosure. The disclosure surfaces (endpoint-creation copy + pricing page) are a required companion and
  must land before billing is activated. Reveal-once credentials (API keys, provider secrets, signing keys)
  are unaffected.
