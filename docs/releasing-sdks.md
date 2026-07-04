# Releasing the SDKs

webhook.co ships three official SDKs, all generated from the one OpenAPI contract
(`packages/openapi/src/openapi.json`, served at `api.webhook.co/openapi.json`). Each publishes to its
own registry with its own release workflow; they can move independently, and a coordinated release keeps
them aligned when the API contract changes.

The canonical list lives in code: `packages/sdks/src/index.ts` (`SDKS`).

| Language   | Package                             | Registry | Release trigger (tag)   | Workflow                                   |
| ---------- | ----------------------------------- | -------- | ----------------------- | ------------------------------------------ |
| TypeScript | `@webhook-co/sdk`                   | npm      | `sdk-ts-v<version>`     | `.github/workflows/release-sdk-ts.yml`     |
| Python     | `webhook-co`                        | PyPI     | `sdk-python-v<version>` | `.github/workflows/release-sdk-python.yml` |
| Go         | `github.com/webhook-co/webhook-go`  | Go proxy | `v<version>` (that repo)| `webhook-go/.github/workflows/release.yml` |

## Provenance (honestly tiered — the registries differ)

- **npm**: full OIDC provenance — sigstore + Rekor + SLSA. `publishConfig.provenance: true` + `id-token: write`.
- **PyPI**: API-token publish via `twine` (the `PYPI_TOKEN` repo secret). PyPI records per-file hashes;
  PEP 740 attestations are best-effort. (An OIDC trusted-publisher flow was the original design, but the
  founder provided an API token rather than configuring a Trusted Publisher.)
- **Go**: no registry upload — integrity is the Go checksum database (`sum.golang.org`) recording the tag's
  tree hash on first fetch, plus an **auxiliary** sigstore attestation over the source archive. This is
  deliberately **not** the same guarantee as npm's provenance; don't market it as "signed like npm".

## Cut a single SDK

1. Ensure `main` is green (the SDK's tests + drift guards pass in CI).
2. Push the SDK's tag at the target version:
   - TS: `git tag sdk-ts-v1.0.0 && git push origin sdk-ts-v1.0.0`
   - Python: `git tag sdk-python-v1.0.0 && git push origin sdk-python-v1.0.0`
   - Go (in the `webhook-go` repo): `git tag v1.0.0 && git push origin v1.0.0`
3. The workflow builds, tests (incl. the generated-types drift guard), and publishes.

## Cut a coordinated release (all three)

When a contract change should ship across every language at the same version `X.Y.Z`:

1. Regenerate + commit each SDK's typed core from the current spec, and confirm all drift guards are green:
   - `pnpm --filter @webhook-co/sdk generate` (then `pnpm --filter @webhook-co/sdk test`)
   - `python -m scripts.generate_models` in `sdks/python` (then `pytest`)
   - Go structs are hand-written; reconcile `webhook-go/models.go` against the spec if entities changed.
2. Push all three tags at `X.Y.Z` (two in this repo, one in `webhook-go`).
3. Verify provenance after publish:
   - npm: `npm view @webhook-co/sdk --json | jq .dist` and check the sigstore attestation on npmjs.com.
   - PyPI: confirm the new version is live at `https://pypi.org/project/webhook-co/`.
   - Go: `gh attestation verify webhook-go-vX.Y.Z.tar.gz --repo webhook-co/webhook-go`.

## First publish (one-time, human-gated)

Publishing is intentionally **dormant** until a maintainer opts in:

- **npm**: the `NPM_TOKEN` repo secret gates the publish step (already configured).
- **PyPI**: the `PYPI_TOKEN` repo secret (a PyPI API token) gates the publish step (already configured).
- **Go**: simply pushing the first `v*` tag makes the module installable (the checksum DB indexes it).

> **Status (2026-07-04):** all three first releases are published — `@webhook-co/sdk@0.1.0` (npm),
> `webhook-co@0.1.0` (PyPI), and `github.com/webhook-co/webhook-go@v0.1.0` (Go). Subsequent releases just
> need a version bump + tag.
