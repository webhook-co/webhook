# ADR 0088 — OpenAPI 3.1 spec provenance: derive schemas from the Zod contract, single-source the HTTP envelope

- status: accepted
- date: 2026-07-01
- scope: `packages/openapi` (new), `apps/api`
- review severity: high (the published spec is the contract SDK consumers + external integrators depend on; a drift here ships a lie)

## context

Epic S7 ships a public OpenAPI 3.1 specification and SDKs generated from it. The API surface is a custom Zod v4
**capability registry** (`packages/contract`, 26 capabilities) exposed as a REST facade by a hand-written
imperative router (`apps/api/src/router.ts`, `matchRoute`). Two sources of truth therefore exist for what the
spec must describe: the **schemas** (Zod, in the contract) and the **HTTP envelope** — verbs, paths, success
status, param locations, and the error representations — which lived only as control flow inside `matchRoute`.

A spec that is hand-authored, or derived from only one of those two sources, drifts silently: a capability adds
a field, a route changes shape, and the published document quietly lies to every SDK and integrator. For an
enterprise-grade, security-conscious API this is unacceptable. The design question (founder-approved after a
red-teamed research pass): how do we guarantee the spec cannot drift from what the server actually does?

## decision

### 1. Schemas are derived from the Zod contract (never hand-authored)

`packages/openapi/src/generate.ts` emits every schema with Zod v4's native `z.toJSONSchema(schema, {
target: "draft-2020-12", io, unrepresentable: "any", override })`. OpenAPI 3.1 **is** JSON Schema 2020-12, so
`draft-2020-12` is exactly the right dialect (not `openapi-3.0`, which rewrites to 3.0 quirks). Request bodies
use `io: "input"`; responses use `io: "output"`. Named entity/enum schemas are registered in a `z.registry()`
so every reference becomes a `$ref` to `#/components/schemas/<Name>` — the codegen tools then emit clean, named
model classes instead of anonymous inline objects (and the 130-member provider enum is defined once).

**`z.coerce.date()` → `{type:"string",format:"date-time"}`** via an `override` callback keyed on
`ctx.zodSchema._zod.def.type === "date"`. The override is a **fail-closed allowlist**: `unrepresentable:"any"`
globally suppresses the throw for *every* unrepresentable node (turning it into `{}`), so the override throws on
anything it does not explicitly render. A future `.transform()`/`bigint` in an output schema then fails the
build loudly instead of silently shipping an `any`. A drift-guard test asserts zero empty-`{}` schemas.

### 2. The HTTP envelope is single-sourced in a declarative route manifest

The hand-written `matchRoute` control flow was refactored into a declarative `ROUTES` table
(`packages/openapi/src/routes.ts`): `{ method, path, capability, successStatus, dispatch, body, query,
buildInput }`. **Both** the runtime router (`apps/api`) **and** the spec generator consume this one table, so
HTTP-layer drift is structurally impossible rather than merely tested. The matching is exact (segment-count +
literal positions), so route order is irrelevant and no request can match two rows. The capability-error →
HTTP-status map (`CAPABILITY_ERROR_STATUS`) is single-sourced in the same module; `apps/api/src/http-status.ts`
re-exports it. The router refactor is behavior-preserving — the pre-existing `router.test.ts` suite passed
unchanged as the characterization net.

### 3. What derivation cannot express is encoded deliberately, and runtime-verified

Three facts about the surface live in `matchRoute`/the gate, not the contract, and would be a lie if inferred:

- **Every success is HTTP 200** (no 201/204). A manifest fact; the drift guard forbids any non-200 2xx.
- **401/403 are EMPTY-body responses carrying a `WWW-Authenticate` header** (RFC 6750), not the JSON
  `{error,message}` envelope the other faults use. Modeled as OpenAPI responses with `headers` and no `content`.
- **The two `.superRefine` request bodies** (`endpoints.addProviderSecret`, `replayDestinations.create`) lose
  their predicate in JSON Schema. Re-added as prose in the request-body `description` — **never a fabricated
  `pattern`**, which no test could catch as a lie.
- **Error responses are the UNION of transport-class faults and the capability's domain faults.** A
  capability's declared `errors` taxonomy is not the whole truth: the auth gate returns **403
  insufficient_scope on every scoped route** and input validation returns **400 on every route with a
  path/query/body**, regardless of what the taxonomy lists. Deriving error responses from `cap.errors` alone
  under-declares (an SDK would have no 403/400 branch). The generator therefore seeds `{401, 500}` for every
  operation, adds 403 for every capability route (not the scope-free whoami), adds 400 wherever input is
  validated, then unions in the domain faults (404/409/429/502). A drift-guard assertion locks this against
  the L3 conformance behavior. Parameter-schema resolution is likewise fail-closed: a `schemaFrom` that
  doesn't resolve throws at build time rather than emitting a lossy untyped string.

### 4. A three-layer drift guard, TDD-first

- **L1 schema integrity** (`packages/openapi`): all 26 capabilities present; every input/output round-trips; no
  dangling `$ref`; no empty-`{}` (any) schema; dates render as `date-time`; the provider enum is a shared component.
- **L2 route bijection**: one operation per manifest route; success status is exactly 200; path params + body
  request components are declared.
- **L3 runtime conformance** (`apps/api/src/routes-conformance.test.ts`): the **real** `handleRequest` is driven
  for every route and asserted to produce 200+JSON on success, empty-body 401/403 with `WWW-Authenticate` on the
  gate, and text/plain on a routing miss — the only layer that proves the hand-written HTTP behavior matches the doc.
- **Golden snapshot**: `packages/openapi/src/openapi.json` is committed; the test re-derives and compares
  byte-for-byte, so every spec change surfaces as a reviewable diff. Regenerate with
  `pnpm --filter @webhook-co/openapi generate`. The doc is validated as real OpenAPI 3.1 by `redocly lint`.

## alternatives considered

- **Hand-author the spec.** Rejected: guaranteed drift, no correctness coupling to the server.
- **Derive schemas but keep a parallel HTTP route table for the generator (leave `matchRoute` as-is).** Rejected
  after red-team: two HTTP sources of truth, and the imperative router is control flow a generator cannot reflect
  over, so the drift is only tested-for, never prevented. The declarative-manifest refactor makes it structural.
- **Emit the `openapi-3.0` target.** Rejected: 3.0 cannot express the 2020-12 constructs the contract uses
  (`type` arrays / nullable unions) without lossy rewrites.

## consequences

- The spec cannot drift from the contract or the router without failing CI (L1/L2/L3 + golden snapshot).
- `apps/api` gains a dependency on `@webhook-co/openapi/routes` (a light, generator-free entry — the worker
  bundle does not pull the generator).
- Adding a capability or route is now a single edit to the contract + the manifest; the golden regen surfaces the
  spec delta for review. The generated `openapi.json` is prettier-ignored (its canonical format is the generator's).
- The spec is the input to the SDK-generation slices (S7 Slices 2–4) and the developer reference (Slice 1).
