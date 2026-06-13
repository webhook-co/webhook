# Branch protection rulesets (`main`)

These two JSON files are the **branch protection rulesets** for `main`, kept as code so they can be
applied reproducibly. They were authored to be applied via `gh`, but **could not be applied yet**:
the `webhook-co` org is on the **free** plan and the repo is **private**, and GitHub gates branch
rulesets behind a paid plan (or a public repo). See the "When you can apply these" section.

## Why two rulesets (this is deliberate)

A ruleset's **bypass actors bypass the entire ruleset**, not an individual rule. To let the founder
self-merge their own PRs *without* ever being able to bypass CI, the rules are split:

- **`main-pull-request.json`** — requires a PR, **1 approval**, dismisses stale approvals on new
  commits, requires **CODEOWNERS** review, and requires **conversation resolution**. The **Admin
  role is a bypass actor in `pull_request` mode**, so the org admin / sole maintainer can
  merge their own PRs without a second approver. Merge methods limited to squash/rebase (linear).
- **`main-status-checks.json`** — requires **status checks** (`install`, `lint`, `format-check`,
  `typecheck`, `test`, `build`, `no-skipped-tests`, `tsconfig-boundary`, `codeql`, `gitleaks`),
  requires the branch to
  be **up to date** (strict), **blocks force-pushes** (`non_fast_forward`), requires **linear
  history**, and blocks branch deletion. **`bypass_actors` is empty** — so **no one, including
  admins, can bypass CI.** Signed commits are intentionally **not** required.

> GitHub repository rulesets cannot target an individual user as a bypass actor; the sole
> maintainer is targeted via the **Admin role** (`actor_type: RepositoryRole`), which they alone
> hold.

## When you can apply these

Pick one (the repo's docs are already public-safe, so option 1 is the cheapest):

1. **Make the repo public** — rulesets, secret scanning, and push protection are all free for
   public repos. (Recommended; the repo is "public later" anyway.)
2. **Upgrade the org to GitHub Team** (paid) — enables rulesets on private repos.

Secret scanning + push protection additionally require **GitHub Secret Protection / Advanced
Security** on private repos (free on public repos).

## Apply (once the plan/visibility allows)

Via the API (preferred, reproducible):

```bash
gh api -X POST repos/webhook-co/webhook/rulesets \
  -H "Accept: application/vnd.github+json" \
  --input .github/rulesets/main-pull-request.json

gh api -X POST repos/webhook-co/webhook/rulesets \
  -H "Accept: application/vnd.github+json" \
  --input .github/rulesets/main-status-checks.json
```

Or in the UI: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then select each
file.

After applying, also enable (Settings → Code security):

- **Secret scanning** + **Push protection**
- (Dependabot **alerts** and **security updates** are already enabled on the repo.)
