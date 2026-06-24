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

1. **A tiny script Worker, not static assets.** `apps/get` does two things: `GET /` and `/install.sh`
   **302-redirect to the installer**; `GET /<asset>` and `/v<ver>/<asset>` **302-redirect** to
   `github.com/webhook-co/webhook/releases/{latest/download|download/cli-v<ver>}/<asset>`. Everything else
   404s. (Static assets can't do the dynamic redirects; a Worker is simpler than asset + redirect rules.)

2. **Redirect to install.sh, don't embed it.** `/` + `/install.sh` 302 to
   `raw.githubusercontent.com/webhook-co/webhook/main/packages/cli/scripts/install.sh` — the repo's
   canonical installer (`curl -fsSL https://get.webhook.co | sh` follows the redirect). The original design
   embedded install.sh as a Text module, but a **Worker-script upload whose bundle contains the shell
   installer (`curl … | sh`, `rm -rf`, `xattr`) is blocked by Cloudflare's API WAF** — an HTML `403` on the
   `PUT /workers/scripts/webhook-get` from any origin (reproduced from both a local box and the GitHub-Actions
   runner; reads + the other Workers' updates succeed). Redirecting keeps the Worker **content-free** so the
   upload passes, with no new dependency (install.sh already needs GitHub for the binaries) and still one
   source of truth (the repo file). install.sh is version-agnostic (it resolves the latest release at
   runtime), so serving `main` is correct.

3. **No open redirect.** Redirect targets are a fixed set — the installer URL (a constant) + the release
   assets (allowlist mirroring release-build.mjs + a `v<semver>` pattern) — always on canonical hosts
   (`raw.githubusercontent.com/webhook-co/webhook/main/…` and `github.com/webhook-co/webhook/releases/…`); a
   caller can never steer the `Location`. Pure routing in `router.ts`, unit-tested (8 cases incl. the
   no-open-redirect + host-pinning checks); `index.ts` is thin Worker wiring.

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
- The Worker is live but inert-ish until the first release: `/` always redirects to the installer; the asset
  redirects resolve to GitHub's own 404 until a release exists.

## alternatives considered

- **Embed install.sh in the Worker (Text-module import).** The original design; **rejected after it failed** —
  the bundled shell content trips Cloudflare's API WAF (403 on the script upload). Redirecting is content-free
  and keeps one source of truth (the repo file).
- **base64-encode install.sh into the bundle** to dodge the WAF while serving it directly (200, not a 302).
  Rejected for now — needs a generate-step + a drift check for a marginal UX gain; the redirect is simpler and
  install.sh already depends on GitHub. (Revisit if a direct 200 from get.webhook.co is wanted.)
- **Workers Static Assets serving a single install.sh + zone Redirect Rules for downloads.** Rejected — the
  Worker does it all in ~50 lines, unit-tested, with no zone-rule sprawl.
- **Re-host the binaries on R2/CF.** Rejected (plan §7) — GitHub Releases is the free CDN + provenance home;
  get just redirects to it.
