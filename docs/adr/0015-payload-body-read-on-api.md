# ADR 0015 — payload-body read on api. (events.getPayload, base64 envelope, read-only R2 binding)

- status: accepted
- date: 2026-06-17
- scope: `packages/contract` (events.getPayload), `apps/api` (route + R2 binding), `packages/cli`
  (api-client + `events payload`), `scripts/gen-wrangler-prod.mjs`
- review severity: medium

## context

The wedge is "payload inspection + one-command replay-to-localhost, identically across CLI/API/web/MCP"
(PRD §1.2). `events.get` returns an event's metadata + ordered headers + the body **ref**
(`payloadR2Key`), but **no capability returns the body bytes** — a real gap. Two consumers need them:
the CLI replay/forward (slice 12, which POSTs the captured request to a local dev server) and the
future web dashboard's payload-inspection panel.

Capability **parity is a non-negotiable** (constitution; ADR-0011 makes reads a shared `api.`+`mcp.`
surface). The decisive constraint: the **web dashboard reads from `api.`** (CORS allowlist = app) and
**cannot reach `wbhk.my` from a browser** — that apex is cookieless, no-CORS by design (ADR-0003).
So serving the body from the engine (`wbhk.my`) would make payload inspection unreachable for web —
a parity break. The body lives in R2 (engine-written, one object per event, ≤1 MiB cap), and `apps/api`
had no R2 binding.

## decision

1. **A new read capability `events.getPayload`** (`packages/contract`): input `{ eventId }`, scope
   `events:read`. Bound on **api + cli**. **web exempt** (dashboard epic, like every read); **mcp
   exempt** — raw payload bytes don't fit the MCP text-tool model and the McpAgent has no R2 binding
   (an agent reads metadata via `events.get`). Both exemptions are documented + dated in the registry.

2. **Output is a JSON base64 envelope** `{ contentType: string | null, bytes: number, bodyBase64:
   string }`, not raw bytes. This keeps the contract's all-JSON, schema-validated model uniform (raw
   bytes would need a bespoke binary transport + a non-JSON client path through the frozen machinery),
   is lossless for binary payloads + exact-byte Standard-Webhooks signature fidelity, and is MCP-shaped
   if ever bound there. At the ≤1 MiB cap the ~1.37× base64 inflation is immaterial for an interactive
   wedge. A raw-bytes representation via content negotiation (`Accept: application/octet-stream`) is a
   noted future option if a non-JSON consumer needs it.

3. **Served from `api.`** (`GET /v1/events/:id/payload`), reusing the shared `events.get` handler for
   the RLS metadata read (so ownership + `NOT_FOUND` are enforced once, in one place), then
   `R2_PAYLOADS.get(payloadR2Key)`. A missing R2 object for a row that DOES exist is a `NOT_FOUND`
   (pruned / half-completed write), not a 5xx. It is special-cased in the router (it is not a pure DB
   `ReadHandler`), inside the same `CapabilityFault → HTTP status` mapping.

4. **A read-only `R2_PAYLOADS` binding on the api Worker** (the same bucket the engine writes).
   "Read-only" is a usage discipline — the api only ever calls `.get` — not a binding mode; a scoped
   R2 token is a future hardening. The deploy overlay reuses the existing `webhook-payloads-dev → -prod`
   token map (`gen-wrangler-prod.mjs`).

## consequences

- The body is a parity-correct read: the CLI (`events payload`, and the slice-12 forwarder via the
  api-client), the future web dashboard, and direct API callers all fetch it identically from `api.`.
  The engine stays the writer; reads stay on `api.` (ADR-0011); the live tunnel stays on `wbhk.my`
  (ADR-0014). No PRD surface-map change.
- **Rejected alternatives:** *engine-serves* (breaks web parity — a browser can't reach cookieless
  no-CORS `wbhk.my`); *api → engine proxy* (a second Worker invocation per fetch + a new internal
  trust boundary, for no latency or cost win).
- The mcp exemption is the one to revisit: an agent payload-preview would add R2 to `apps/mcp` + a
  text/base64 representation. Tracked in the registry's exemption reason.
- The conformance gates move in lockstep: `capabilities.test` `EXPECTED_NAMES`, `parity.test`
  live-bindings (api + cli; mcp/web exempt), and the CLI `app.test` `CAPABILITY_COMMANDS`
  (`events payload`).
