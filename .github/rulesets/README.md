# Branch protection rulesets (`main`)

These two JSON files are the **branch protection rulesets** for `main`, kept as code so they can be
applied reproducibly.

> **Both rulesets are APPLIED and `active`** — `main — pull request & review` (id `17511674`) and
> `main — status checks & history` (id `17511675`). This paragraph used to say they "could not be
> applied yet" because the org was on the free plan with a private repo; the repo is public now, so
> that blocker is gone and the rulesets were applied. Verify with
> `gh api repos/webhook-co/webhook/rulesets` rather than trusting this file — a config-as-code file
> that has drifted from reality is worse than no file, which is exactly what happened here.

## Why two rulesets (this is deliberate)

A ruleset's **bypass actors bypass the entire ruleset**, not an individual rule. To let the founder
self-merge their own PRs *without* ever being able to bypass CI, the rules are split:

- **`main-pull-request.json`** — requires a PR, **1 approval**, dismisses stale approvals on new
  commits, requires **CODEOWNERS** review, and requires **conversation resolution**. The **Admin
  role is a bypass actor in `pull_request` mode**, so the org admin / sole maintainer can
  merge their own PRs without a second approver. Merge methods limited to squash/rebase (linear).
- **`main-status-checks.json`** — requires **17 status checks** (the authoritative list is the JSON
  itself; do not re-spell it here, because a hand-maintained second copy is what drifted last time),
  requires the branch to be **up to date** (strict), **blocks force-pushes** (`non_fast_forward`),
  requires **linear history**, and blocks branch deletion. **`bypass_actors` is empty** — so **no one,
  including admins, can bypass CI.** Signed commits are intentionally **not** required.

  Every required job runs **unconditionally** on `pull_request` — `ci.yml` has no workflow-level
  `paths:` filter and none of these jobs carries an `if:`. That is load-bearing: a required check that
  does not report on some PRs blocks those PRs forever, and `bypass_actors` is empty. **Verify a job
  reports on an unrelated PR before adding it to this list.**

> GitHub repository rulesets cannot target an individual user as a bypass actor; the sole
> maintainer is targeted via the **Admin role** (`actor_type: RepositoryRole`), which they alone
> hold.

## Changing a ruleset

These files are **not** applied by CI — nothing watches them, so editing one changes nothing until
you push it. That is the drift trap: the previous version of this file listed 10 checks while the live
ruleset had 15, and named `tsconfig-boundary` as required when it was not.

Rulesets already exist, so **UPDATE** (`PUT` by id) rather than re-`POST`, which would create a
duplicate:

```bash
gh api -X PUT repos/webhook-co/webhook/rulesets/17511674 \
  -H "Accept: application/vnd.github+json" \
  --input .github/rulesets/main-pull-request.json

gh api -X PUT repos/webhook-co/webhook/rulesets/17511675 \
  -H "Accept: application/vnd.github+json" \
  --input .github/rulesets/main-status-checks.json
```

Then confirm the live state matches the file:

```bash
gh api repos/webhook-co/webhook/rulesets/17511675 \
  --jq '[.rules[] | select(.type=="required_status_checks")
         | .parameters.required_status_checks[].context] | sort'
```

Secret scanning + push protection are enabled separately (Settings → Code security); they are free on
public repos.

After applying, also enable (Settings → Code security):

- **Secret scanning** + **Push protection**
- (Dependabot **alerts** and **security updates** are already enabled on the repo.)
