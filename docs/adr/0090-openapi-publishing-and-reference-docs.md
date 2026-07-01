# ADR 0090 — publishing the OpenAPI spec; reference docs render on Mintlify

- status: accepted
- date: 2026-07-01
- scope: `apps/api`, `packages/openapi`
- review severity: low (a new public, unauthenticated, read-only spec route)

## context

ADR-0088 produced a contract-synced OpenAPI 3.1 document (`packages/openapi/src/openapi.json`). S7 Slice 1
publishes it. The **docs platform is already decided**: internal ADR-0006 ("Docs on Mintlify (free)",
accepted 2026-06-10; reaffirmed in the PRD §9 + subdomain table) puts developer documentation on **Mintlify**
at **`docs.webhook.co`** — Mintlify free covers a custom domain + TLS, unlimited pages, an API playground, and
MCP integration. So this ADR is only about **serving the machine-readable spec** that Mintlify (and SDK
generators, Postman, editors) consume; the rendered API reference is Mintlify's job, built as the final S7
slice from this same document.

(An earlier revision of this slice served a Redoc page from the API Worker — that contradicted the Mintlify
decision and was removed before merge.)

## decision

### 1. Serve the machine-readable spec at `GET /openapi.json` — public, CORS-open

Added to `apps/api/src/index.ts` in the pre-router public block (alongside `GET /` and the RFC 9728 PRM
route), served **before** any tenant deps are built — unauthenticated, no DB, no bearer gate. The spec is
public and non-secret, so the response carries `Access-Control-Allow-Origin: *` (cross-origin fetch by the
docs site + SDK tooling is the point) and `Cache-Control: public, max-age=300`. The document is imported as
**static JSON** (`@webhook-co/openapi/openapi.json`, a new package `exports` entry) — **not**
`buildOpenApiDocument()` — so the zod/generator code never enters the Worker bundle; what is served is exactly
the committed golden artifact.

### 2. Reference docs render on Mintlify (not in the API Worker)

The API Worker serves only the machine-readable spec. The human-facing reference — endpoint pages, schemas,
and the interactive playground — is rendered by **Mintlify on `docs.webhook.co`**, consuming
`https://api.webhook.co/openapi.json`. That docs site is built as the last S7 slice (after the SDKs, so it can
also document SDK usage), on-voice per the `docs-and-api-reference` skill. There is deliberately **no built-in
docs UI** (Redoc/Scalar/Swagger) served from our own origin.

### 3. Gate spec validity in CI

`packages/openapi`'s `test` script runs `redocly lint src/openapi.json` (via the reused `validate` script)
after the vitest drift guard, so the existing CI `test` job fails on an invalid OpenAPI 3.1 document. This is
a platform-agnostic **validator**, not a renderer — it does not conflict with the Mintlify docs choice, and it
needs no marketplace GitHub Action (org policy): `@redocly/cli` is a direct devDependency invoked as a CLI.

## consequences

- One new public, unauthenticated GET route (`/openapi.json`); it builds no tenant deps and never touches the
  bearer gate, so the auth posture is unchanged.
- The spec URL is the single input the Mintlify docs site, the S7 SDK slices (2–4), and any external tool
  consume.
- Truthful, runnable **examples** are produced where they matter most — the generated SDK READMEs/guides and
  the Mintlify pages — sourced from real conformance/adapter fixtures, rather than hand-embedded in the spec now.
