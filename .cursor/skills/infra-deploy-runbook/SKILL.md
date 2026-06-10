---
name: infra-deploy-runbook
description: Deploy and operate the Cloudflare-forward webhook stack safely. Use when deploying Workers, Durable Objects, or container-lane services, configuring wrangler/bindings, rolling back, or running production infra changes.
---

# Infra deploy runbook

Operate the Cloudflare-forward stack (Workers + Durable Objects, Neon via Hyperdrive, R2, KV) and
the container-delivery lane behind the seam.

## Before any deploy

1. Confirm the change is reproducible from `infra/` and carries no secrets or account/zone IDs.
2. Run a plan/dry-run first (`wrangler deploy --dry-run`, IaC plan). Read the diff.
3. Identify blast radius: does it touch DNS/routing for `webhook.co` or `wbhk.my`, drop/recreate
   resources, or rotate production secrets? If yes → stop and get human review.

## Deploy order (per service)

1. Apply additive changes first (new bindings, new DO classes, expand-phase migrations).
2. Deploy the Worker/service; verify health + OpenTelemetry traces before shifting traffic.
3. Watch error rate and delivery latency; keep the previous version ready to roll back.

## Guardrails (non-negotiable)

- Default new compute to Workers / DO. Don't reintroduce rejected stack alternatives without an ADR.
- Preserve the **container-delivery seam** — never couple the engine to a specific delivery backend.
- Keep `wbhk.my` ingestion cookieless, no-CORS, path-token routed, `404` for unknown tokens.
- Secrets via `wrangler secret` / secret store only. No literals, no account IDs in the repo.

## Rollback

- Workers: redeploy the prior version. DO: ensure schema is backward-compatible before cutover so
  rollback is safe. Migrations: only ship the contract phase once rollback is no longer needed.

## Progressive disclosure

Put environment-specific checklists, binding maps, and step-by-step rollback drills in
`references/` (e.g. `references/rollback.md`) and link them here rather than inlining detail.
