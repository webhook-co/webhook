# ADR 0097 — the Mintlify documentation site (docs.webhook.co)

- status: accepted
- date: 2026-07-04
- scope: `apps/docs/`
- review severity: low (docs content + config; no runtime, auth, or data surface) — but it is a
  user-facing UI deliverable, so the rendered site requires human visual verification before it ships.

## context

S7's final slice is the developer documentation site. The platform was already decided (internal ADR-0006:
"Docs on Mintlify (free)"); this ADR records how the Mintlify project is laid out **inside this monorepo**
and how it consumes the S7 outputs. It is the counterpart to ADR-0090, which deliberately did **not** serve
a docs UI from the API Worker precisely so the reference could render on Mintlify.

## decision

### 1. `apps/docs/` — a surface alongside the others, but not a workspace package

Mintlify content lives in `apps/docs/`, next to the other product surfaces (`apps/www`, `apps/web`, …).
It is deliberately **not** a pnpm/turbo workspace package: it has no `package.json`, so — even though
`apps/*` is a workspace glob — pnpm and turbo skip it (a matched directory with no manifest is not a
package), and Mintlify's GitHub App builds it externally rather than our CI. This keeps the docs where a
reader expects them (a product surface under `apps/`) without dragging externally-built content into the
build/test/lint task graph. (An earlier revision placed it at a top-level `docs-site/` to stay clear of
the workspace globs entirely; `apps/docs/` was chosen for discoverability once the no-`package.json`
approach was verified clean.) Not `docs/`, which holds the code ADRs + threat model. Layout: `docs.json`
(config) + hand-authored `.mdx` guides + per-language SDK pages under `sdks/` + a `favicon.svg`.

### 2. The API reference is generated from the live remote spec

`docs.json` sets `"openapi": "https://api.webhook.co/openapi.json"` on the API-reference tab, so Mintlify
auto-generates the endpoint pages + interactive playground from the **served** spec (ADR-0090) — there is
no committed spec copy to drift. A spec change doesn't touch `apps/docs`, so it won't auto-redeploy; the
playground re-fetches the spec on the next docs redeploy — triggered by a push touching `apps/docs` or a
manual **Redeploy** from the dashboard (the API-driven resync needs an Enterprise `mint_` key we don't use).

### 3. Deploy is Mintlify's GitHub App; the domain + one-time setup are founder-gated

There is no CI job or marketplace Action for docs (consistent with the org's Actions policy). Deploy is
Mintlify's GitHub App on push to `main`, with the monorepo path set to `apps/docs`. The one-time steps
that can't be done from the repo — installing the GitHub App, the monorepo toggle, adding the
`docs.webhook.co` custom domain (which reveals the DNS verification values), and the Cloudflare CNAME/TXT
records — are documented in `apps/docs/README.md` for a maintainer. (The API-driven spec-resync would need
a `mint_` admin key, but that's a paid Enterprise feature; on the Hobby tier we redeploy manually after a
spec change instead.)

## consequences

- The site can't go live from a merge alone; it requires the founder-gated dashboard steps, and the
  rendered result (layout, brand colours, playground) must be eyeballed by a human before it's considered
  done — so this slice is handed off for verification rather than auto-merged.
- Once live, docs, SDK guides, and the API reference all trace back to the single OpenAPI contract, closing
  the loop S7 opened: one contract → spec → three SDKs → docs.
