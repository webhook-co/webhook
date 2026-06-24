# ADR 0068 — get.webhook.co install/download Worker (distribution DIST-5b)

- status: accepted (distribution Phase 2 fast-follow — the branded install endpoint).
- date: 2026-06-24
- scope: new `apps/get/` Worker (`webhook-get`) + `.github/workflows/deploy-get.yml`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-5b). ADR-0065 (install.sh + binaries this serves),
  the deploy-www CD pattern it mirrors.
- review severity: medium (a public edge Worker on the shared zone). `/code-review` + `/security-review`.

## context

`install.sh` (ADR-0065) advertises `curl -fsSL https://get.webhook.co | sh`, but nothing served that host.
DIST-5b stands up a thin Cloudflare Worker on the existing CF stack so the branded one-liner works, and so
versioned/`latest` download paths resolve to the GitHub release assets — without re-hosting the binaries
(GitHub Releases stays the CDN + provenance home).

## decision

1. **A tiny script Worker, not static assets.** `apps/get` serves two things: `GET /` and `/install.sh`
   return the installer; `GET /<asset>` and `/v<ver>/<asset>` **302-redirect** to
   `github.com/webhook-co/webhook/releases/{latest/download|download/cli-v<ver>}/<asset>`. Everything else
   404s. (Static assets can't do the dynamic redirects; a Worker is simpler than asset + redirect rules.)

2. **One source of truth for install.sh.** The Worker imports the canonical
   `packages/cli/scripts/install.sh` as a **Text module** (wrangler `rules: [{ type: "Text" }]`), so the
   served script is always the repo's installer — no copy to drift. The CD path filter includes install.sh,
   so editing the installer redeploys get.

3. **No open redirect.** Redirect targets are restricted to a fixed asset allowlist (mirroring
   release-build.mjs) + a `v<semver>` pattern, and the host is always the canonical releases base — a caller
   can never steer the `Location`. Pure routing logic lives in `router.ts` and is unit-tested (8 cases incl.
   the no-open-redirect + host-pinning checks); `index.ts` is thin Worker wiring.

4. **Committed custom domain.** Unlike the wedge/auth Workers (per-env routes with zone ids injected by a
   deploy overlay), get is a single fixed **public** hostname with no secrets, so the custom domain
   (`get.webhook.co`) is committed in `wrangler.jsonc` — `wrangler deploy` provisions + maintains it (DNS +
   cert) idempotently. `workers_dev: false` (prod is the custom domain only); `preview_urls: true` so a PR
   dry-run validates the bundle.

5. **CD mirrors deploy-www.** `deploy-get.yml` calls `wrangler` directly (org blocks 3rd-party Marketplace
   actions), same-repo-only, `contents: read`, push→deploy / PR→dry-run, not a required check.

## consequences

- `curl -fsSL https://get.webhook.co | sh` works (once the founder publishes the first `cli-v*` release the
  installer can actually fetch); `https://get.webhook.co/wbhk-darwin-arm64` 302s to the latest binary.
- Host-scoped security headers (nosniff, HSTS without includeSubDomains, referrer-policy) — HSTS can't bleed
  onto api./mcp./auth. on the shared zone.
- The Worker is live but inert-ish until the first release: `/` always serves the installer; the redirects
  resolve to GitHub's own 404 until a release exists.

## alternatives considered

- **Workers Static Assets serving a single install.sh + zone Redirect Rules for downloads.** Rejected — the
  Worker does both in ~40 lines, unit-tested, with no zone-rule sprawl.
- **Re-host the binaries on R2/CF.** Rejected (plan §7) — GitHub Releases is the free CDN + provenance home;
  get just redirects to it.
- **Inline a copy of install.sh in the Worker.** Rejected — two sources of truth drift; the Text-module
  import keeps one.
