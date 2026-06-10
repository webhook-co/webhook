# Contributing

Thanks for helping build `webhook`. This guide covers local setup, the checks we run, and the
merge model. Start with [`AGENTS.md`](AGENTS.md) for the product constitution and conventions.

## Prerequisites

- **Node** — version pinned in [`.nvmrc`](.nvmrc) (Node 24). Use `nvm use` (or `fnm`, `volta`).
- **pnpm** — version pinned via `packageManager` in `package.json`. Enable with
  `corepack enable` and pnpm will match automatically.

## Setup

```bash
pnpm install
```

This is a **Turborepo + pnpm workspaces** monorepo:

- `apps/` — runnable services: `api`, `engine` (Workers + Durable Objects), `web`, `mcp`.
- `packages/` — libraries: `cli`, `sdks`, `portal-sdk`, `webhooks-spec`, `shared`.
- `ee/` — proprietary, license-fenced (excluded from self-host builds; open core must not import it).
- `infra/` — infrastructure as code.

## Everyday commands

```bash
pnpm lint            # ESLint (incl. security rules) + the no-skipped-tests guard
pnpm format          # Prettier write   (pnpm format:check to verify only)
pnpm typecheck       # tsc --noEmit across the workspace
pnpm test            # Vitest (shared: coverage-gated; engine: runs in the Workers runtime)
pnpm build           # turbo build
pnpm no-skipped-tests # fail if any focused/skipped/disabled tests are committed
```

### Lint/format choice — ESLint + Prettier (+ security plugins)

We use **ESLint + Prettier** rather than Biome. Rationale: this is a **compliance-by-design**
product, and ESLint's plugin ecosystem gives us security-focused static analysis
(`eslint-plugin-security`) and room for typed-lint rules that Biome doesn't yet match. Prettier
owns formatting so ESLint can focus on correctness/security. (If lint performance ever becomes a
bottleneck, revisit Biome — the trade-off is a smaller security-rule ecosystem.)

### Testing & coverage

- Tests run with **Vitest**. Workers/Durable Object code runs under
  `@cloudflare/vitest-pool-workers`, i.e. inside the real `workerd` runtime, not a Node shim.
- The `shared` package enforces a **modest 80% coverage threshold** (lines/functions/statements/
  branches) in its `vitest.config.ts`. This is a starting gate meant to rise as the package grows.
  **Never lower a threshold to make CI pass** — add tests instead.

## Git hooks (local convenience only)

We install **husky + lint-staged**:

- **pre-commit** — formats + lints staged files, blocks focused/skipped tests, and typechecks.
- **pre-push** — runs tests for affected packages.

These hooks are a **convenience layer to catch problems early**. They are **bypassable** with
`git commit --no-verify` / `git push --no-verify`. The **real, authoritative gate is CI** — the
required status checks on every PR. (Per [`AGENTS.md`](AGENTS.md), bypassing tests is a
non-negotiable no: do not use `--no-verify` to land work.)

## Merge model

- Work happens on a branch and lands via **pull request** to `main`. Direct pushes to `main` are
  blocked by a branch ruleset.
- Every PR needs **1 approving review** and **CODEOWNERS** sign-off; stale approvals are dismissed
  on new commits; **all conversations must be resolved**.
- The PR branch must be **up to date** and **all required checks green**: `install`, `lint`,
  `format-check`, `typecheck`, `test`, `build`, `no-skipped-tests`, plus `codeql` and `gitleaks`.
- History is **linear** (squash/rebase) and **force-pushes are blocked**.
- **Status checks cannot be bypassed by anyone — including admins.** The founder may self-merge
  their own PRs (a narrow bypass of the *approval* requirement only); the checks still must pass.

If you require human UI/visual verification, **say so in the PR and stop** — a human must verify
before merge. See the pull request template.
