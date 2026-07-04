# ADR 0091 — the TypeScript SDK (@webhook-co/sdk)

- status: accepted
- date: 2026-07-04
- scope: `packages/sdk-ts`, `.github/workflows/release-sdk-ts.yml`
- review severity: medium (a new public, published package carrying a live credential)

## context

S7 turns the OpenAPI contract (ADR-0088, served at `api.webhook.co/openapi.json` per ADR-0090) into
signed, multi-language SDKs. This slice ships the first: the TypeScript SDK, published to npm as
`@webhook-co/sdk`. The existing CLI client (`packages/cli/src/api-client.ts`) is a hand-written,
contract-typed HTTP client — a ready-made parity oracle for the hardened behaviour the SDK must have,
but it depends on the private `@webhook-co/contract` + `@webhook-co/shared` workspaces and so can't ship
as a public package.

## decision

### 1. Typed core generated from the spec; hardened runtime hand-authored

The wire types are generated from the golden `openapi.json` with **`openapi-typescript`** (a pure-Node,
types-only generator — no Java/Docker, fits the local dev loop), committed to `src/generated/schema.d.ts`
and **drift-guarded** exactly like the golden spec (a test re-renders from the spec and diffs; the file
is prettier-ignored). Everything else — the client, retries, pagination, idempotency, redaction, and the
typed error hierarchy — is hand-authored, so no third-party template sits in the published artifact and
the security-sensitive paths are ours to test. This is the founder-approved "OSS-auditable core + we
hand-build the hardened layer", with the per-language-best-OSS-tool choice resolving TS to a pure-Node
generator (OpenAPI Generator needs a JVM/Docker; reserved for the Python/Go slices).

### 2. Compile-time types, no runtime schema validation

The SDK does **not** re-validate responses against a runtime schema. Types are compile-time only; the
server is the contract's source of truth and is itself drift-guarded (ADR-0088), so re-validating in the
client would duplicate that enforcement and drag a Zod runtime into every consumer's bundle. The one
runtime integrity check we *do* keep is structural, not schematic: `events.getPayload` length-checks the
decoded body against the declared `bytes` (a truncated payload throws rather than silently short-reading).

### 3. A hardened runtime at parity with the CLI client

Ported behaviour, verified against the CLI oracle: bearer injection; bounded retries with capped
exponential backoff + jitter, honouring `Retry-After`, **gated to idempotent requests** (a create/rotate/
un-keyed replay is never blind-retried → no duplicate side effects); a single reactive bearer refresh on
a 401 (for OAuth flows); a per-request wall-clock timeout; the three server error shapes (JSON
`{error,message}`, empty-body 401/403, text/plain router miss) resolved into a typed `WebhookError`
hierarchy; https-only base-URL resolution (loopback http allowed for dev) so the credential can't be
downgraded to plaintext or redirected to a hostile host; and **secret redaction** on every human-facing
string (a bound redactor plus a structural backstop for `whk_`/`whsec_`/`Bearer` tokens), covered by a
redaction regression test.

### 4. A directly-publishable, runtime-agnostic package

Unlike the CLI (which bundles workspace deps into a generated manifest), the SDK has **no workspace
runtime deps**, so it publishes directly: a dual **ESM + CJS + `.d.ts`** build via `tsup`, `files:
["dist"]`, `publishConfig: {access:"public", provenance:true}`. It targets web-standard `fetch` /
`AbortSignal` (lib `DOM`, no `@types/node`), so it runs on Node 18+, browsers, Deno, Bun, and Workers.
Release is a tag-triggered workflow (`sdk-ts-v*`) that tests (incl. the drift guard), builds, smokes both
module formats, and `npm publish`es with OIDC provenance — gated on a real tag push + `NPM_TOKEN`, so the
first publish is a deliberate human action (the plan's human-gated checkpoint).

## consequences

- npm gets full sigstore/Rekor provenance parity with the CLI's npm package. The Python and Go slices
  follow with their registries' own (weaker, honestly-tiered) provenance models.
- A spec change now ripples to three drift guards — the golden `openapi.json`, and the SDK's generated
  types — each failing CI if not regenerated, so the SDK types can't silently diverge from the API.
- The compile-time-only stance means a server response that violates the contract surfaces as a type
  mismatch at the call site (or an unexpected-response error on malformed JSON), not a schema throw. This
  is the deliberate trade for a dependency-free, tree-shakeable client.
- New devDependencies (`openapi-typescript`, `tsup`) are build-time only; the published package ships
  `dist/` with zero runtime dependencies.
