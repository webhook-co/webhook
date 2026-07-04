# ADR 0094 — the Python SDK (webhook-co)

> Renumbered from 0092→0093→0094 (each prior number was claimed by a parallel dashboard-slice ADR).

- status: accepted
- date: 2026-07-04
- scope: `sdks/python`, `.github/workflows/ci-sdk-python.yml`, `.github/workflows/release-sdk-python.yml`
- review severity: medium (a new public, published package carrying a live credential)

## context

S7 Slice 3 ships the Python SDK, published to PyPI as `webhook-co`, generated from the same OpenAPI
contract as the TypeScript SDK (ADR-0091). The founder's codegen directive is "per-language best OSS tool
+ hand-build the hardened runtime layer, no closed vendor / no template in the signed path". For Python
that resolves — like TS did — to a **types-only** generator plus our own client, rather than OpenAPI
Generator's full-client template (which also needs a JVM/Docker the dev loop lacks).

## decision

### 1. Types generated with `datamodel-code-generator`; hardened runtime hand-authored

Pydantic v2 models are generated from the golden `openapi.json` with **`datamodel-code-generator`** (pure
pip, no JVM/Docker), committed to `src/webhook_co/_generated/models.py` and **drift-guarded** by a test
that re-renders from the spec and diffs the bytes — reproducible via **pinned** tool versions
(`datamodel-code-generator` + `black` + `isort`). Generation flags of note: `--snake-case-field` (idiomatic
`endpoint.org_id` with camelCase aliases + `populate_by_name`, so the wire JSON still parses);
`--type-mappings uuid=string` (the spec pairs `format: uuid` with a `pattern`, which pydantic can't apply
to a `UUID` type — `str` keeps the pattern valid and matches the TS SDK's string ids); and
`--extra-fields ignore` (see §3); `--ignore-enum-constraints` (response enums are emitted as open `str`,
not closed `Enum`, so an SDK pinned to an older spec doesn't crash on a NEW server-side enum value — e.g. a
newly-added provider — upholding the `extra=ignore` forward-compat promise for enums too); and a
post-generation **scalar-RootModel collapse** (datamodel-code-generator wraps a constrained scalar inside an
`anyOf: [scalar, null]` in a named `RootModel`, which would make `delivery.status_code == 200` silently
False — the collapse inlines those to plain `int | None` / `str | None`, matching the TS SDK). The
generate → collapse → black pipeline lives in one `render()` used by both the generator and the drift test,
so the committed bytes stay exactly reproducible. Everything else — the client, retries, pagination,
idempotency, redaction, and the typed error hierarchy — is hand-authored and strict-TDD (116 tests, 100%
coverage; two adversarial reviews' findings all resolved before merge).

### 2. Responses parsed into validated pydantic models

Unlike the TS SDK (compile-time types only), the Python SDK parses each response into its pydantic model —
runtime validation is idiomatic in Python and effectively free once pydantic is the model layer, and it
gives typed, attribute-accessible results. A shape that violates the contract surfaces as a
`WebhookUnexpectedResponseError` (never a raw `pydantic.ValidationError`). This is a deliberate
per-language difference from ADR-0091 §2, justified by the languages' different idioms.

### 3. Forward-compatible, and hardened at parity with the CLI oracle

Models use `extra='ignore'`, so the API adding a response field never breaks an older SDK (required fields
and types are still validated, so a genuine breaking change still surfaces). The runtime mirrors the CLI
`api-client.ts` oracle: bearer injection; bounded retries with jittered backoff honouring `Retry-After`,
**gated to idempotent requests** (no duplicate side effects); a single reactive 401 bearer refresh (with
the rotated token added to the redactor); a per-request timeout; `httpx` built with
`follow_redirects=False` so the `Authorization` header can't be replayed cross-origin; https-only
base-URL resolution; the three server error shapes resolved into a typed `WebhookError` hierarchy; and
secret redaction on every human-facing string, covered by a redaction regression test. Sync-only for now
(`httpx.Client`); an async client is a possible follow-up, not a stub.

### 4. Runtime + release

httpx + pydantic v2; Python 3.10+. Built with hatchling (src layout). CI is a dedicated, path-filtered
workflow (`ci-sdk-python.yml`) since the package lives outside the pnpm/turbo workspace — format checks +
the full pytest suite (incl. the drift guard). Release (`release-sdk-python.yml`, tag `sdk-python-v*`)
publishes to PyPI with `twine` using the **`PYPI_TOKEN` repo secret** (a PyPI API token) — a plain CLI, no
marketplace action, honouring the org's GitHub-owned-Actions-only policy (the `pypa/gh-action-pypi-publish`
action is deliberately avoided). The publish step is gated on the secret being present.

> **Update (2026-07-04):** this ADR originally specified an **OIDC trusted-publisher mint-token flow**
> (no stored token). In practice the founder provided a PyPI API token rather than configuring a Trusted
> Publisher, so the release workflow now publishes via `twine` + the `PYPI_TOKEN` secret. The no-marketplace
> constraint still holds (`twine` is a direct CLI). `webhook-co@0.1.0` shipped this way on 2026-07-04.

## consequences

- A spec change now ripples to a third drift guard (the golden `openapi.json`, the TS generated types, and
  the Python generated models), each failing CI if not regenerated — so no SDK's types can silently drift.
- PyPI's provenance model is weaker than npm's (no per-artifact sigstore attestation via this path); PEP
  740 attestations are still experimental and are a best-effort follow-up. This is the honest registry
  tiering — Python gets tokenless OIDC auth now, richer attestations later.
- The runtime-validation stance (a per-language deviation from TS) means a contract-violating response
  raises `WebhookUnexpectedResponseError` rather than being handed to the caller mistyped — a stronger
  guarantee that costs a pydantic dependency the Python ecosystem already expects.
- New pinned dev tooling (`datamodel-code-generator`, `black`, `isort`, `pytest`) is build/test-time only;
  the published wheel ships `webhook_co` with just `httpx` + `pydantic` as runtime deps.
