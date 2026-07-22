# Provider page substance, and closing the content-dup-guard's coverage gap

- **Date:** 2026-07-22
- **Relates to:** ADR-0129 (programmatic provider content), `scripts/content-dup-guard.mjs`,
  `packages/webhooks-recipes/src/docs-page/`, `apps/www/src/lib/tutorials.ts`

## Context

Seven hand-authored pages under `apps/docs/providers/` sit below the 150-word substance floor that
`scripts/content-dup-guard.mjs` enforces on every `pnpm lint`. The guard has never seen them.

### What was actually measured

Measured with the guard's own pipeline (`mdxToText` → `tokens`), not a hand count:

| words | page | | words | page |
|---|---|---|---|---|
| 110 | `square` | | 142 | `adyen` |
| 116 | `shopify` | | 147 | `github` |
| 124 | `hubspot` | | 153 | `stripe` (clears) |
| 131 | `slack` | | 161 | `braintree` (clears) |
| 134 | `twilio` | | 171 | `meta` (clears) |

**Seven pages are below the floor, not eight.** `stripe` clears it at 153. This reproduces
ADR-0129's own closing line — "Seven pre-existing hand-authored provider pages sit below the floor
(110–147 words)" — exactly. The count and the range both match.

### The root cause is not a missing generator

The manifest at `scripts/generated/programmatic-pages.json` **is** generated, by
`pnpm --filter @webhook-co/webhooks-recipes gen:docs`
(`WEBHOOK_DOCS_WRITE=1 vitest run src/docs-page/generate.test.ts`), and it is drift-pinned: a
non-write test asserts the committed manifest is byte-identical to a fresh build.

The real defect is the manifest's **scope**. `buildManifest()` iterates `CURATED`, so the manifest's
page set is defined as *"what this template emits"* rather than *"what ships"*. Everything outside
the template is invisible to the floor by construction. ADR-0129 §4 made that choice deliberately
and stated the reason: including the hand-authored pages while they were thin would have meant
exempting them, i.e. relaxing a live gate.

That reasoning was sound, and it expires the moment the pages clear the floor honestly. This lane
removes the precondition, then removes the exclusion. No threshold moves.

### The gap is larger than the docs pages

The guard's header comment says its whole purpose is **cross-host** dedup: `/providers/{slug}`
references on docs versus `/test/{slug}` tutorials on www, "generated from the SAME registry recipe
rows", where "no single `out/` holds both". ADR-0129 §1 repeats it: "there is no cross-domain
`rel=canonical`, so the cross-host duplicate guard is the only backstop and must stay wired."

**The manifest contains zero www pages.** Sixteen tutorials ship at `/test/{slug}`; nine share a
slug with a docs provider page (`discord`, `slack`, `stripe`, `github`, `shopify`, `hubspot`,
`twilio`, `zendesk`, `sendgrid`). Not one cross-host pair has ever been compared. The backstop the
ADR calls "the only backstop" is not wired to anything.

`apps/www/src/lib/tutorials.ts` states in its own header comment that templated tutorial prose
measures **0.91** Jaccard — over the 0.8 reject line — while individually-authored prose measures
~0.23. That is a measured, demonstrated failure mode recorded in a comment and enforced by nothing.

### Measured headroom (all with the guard's own code)

| comparison | max Jaccard |
|---|---|
| generated ↔ generated (full shared template) | 0.2878 |
| hand ↔ hand (docs) | 0.068 after the rewrite (0.07 before) |
| hand ↔ generated | 0.0360 |
| www tutorial ↔ www tutorial | 0.0036 |
| www ↔ docs, same provider | 0.005 |

Two consequences. First, the 0.8 threshold has large headroom — adding a structured spec section to
the hand-authored pages will not approach it. Second, and stated plainly: at today's values none of
the newly-covered pairs can fail. Their value is the **floor**, which fires immediately, plus
regression protection against a demonstrated 0.91 failure mode. A similarity number is evidence only
for the comparison it was measured on (ADR-0129's own lesson), and this design does not claim more.

## Decision

### 1. The manifest's scope becomes "what ships", not "what this template emits"

`buildManifest()` stops iterating `CURATED` and enumerates `apps/docs/providers/` from disk —
generated and hand-authored alike. The brand token the guard neutralizes comes from
`CURATED[slug].displayName`, falling back to the page's frontmatter `sidebarTitle`. (An earlier draft
of this spec said "from the registry by slug". That was wrong: `RecipeDescriptor` carries no display
name, deliberately. `signatureHeader` does come from the registry.)

www emits its own fragment from `TUTORIALS`, reusing the already-exported `tutorialText()`. Two
fragments rather than one file, because a package may not reach into an app for its data — the guard
merges them, which is what makes a cross-host pair a pair.

No exclusion list. `directory.mdx`, `custom.mdx` and `verifying-provider-webhooks.mdx` are included
and clear the floor by a wide margin (729–1545 words). An exclusion list is a hole that rots.

### 2. The fragment list is discovered, not declared

The guard globs `scripts/generated/*-pages.json`, with a floor of two. A hardcoded array of fragments
would reproduce the exact defect this lane is fixing, one level up: a new estate emits a fragment,
nobody edits the array, and the guard reports "clean" over a set that silently excludes it. A third
estate — a `/vs/*` tree, a future guides tree — needs no change to the guard to be covered.

### 3. Completeness is checked where the floor is checked

The generators assert their own completeness, but those assertions run under `pnpm test` while the
floor runs under `pnpm lint`. A fragment holding 3 of 20 pages passes every quantity check the guard
has and still prints "all above the substance floor".

So the guard verifies its own input against the shipped estate on disk: every
`apps/docs/providers/*.md(x)` must have a `docs:` entry, and every `apps/www/src/app/test/*/` route
must have a `www:` entry. Route directories and page files are inventories neither generator
consults. `.md` counts as a page because `docs-nav-guard` treats it as one — a glob that saw only
`.mdx` would let one ship unmeasured.

Turbo's `test` task previously hashed only its own package, so a PR touching only a provider page
could replay the drift test from cache and ship a stale manifest green. The task now declares
`$TURBO_ROOT$`-relative inputs covering `apps/docs/providers/**`, `apps/docs/docs.json` and
`scripts/generated/**`; the task hash was verified to change when a provider page changes.

### 4. Zero-input floors on every counting step

`analyzePages()` throws on an empty page set. Fragment discovery throws below two. Each coverage
inventory throws on an empty directory. Each generator throws on an empty enumeration. The
non-empty-but-wrong-subset case — the one a count cannot catch — is caught by §3's disk comparison.

### 5. Hand-authored pages are asserted against the registry

Hand-authored pages are not drift-pinned to the engine. For every page whose slug is a registry slug,
the page must state the algorithm and the encoding the engine uses, and must name the signature
header the engine reads — or, where the signature travels in the body, must not name one.

The assertion is anchored to the page's `**Algorithm**` bullet and to a word-boundary match on the
header — not a substring scan of the whole file. That distinction is load-bearing: several of these
pages legitimately discuss a second encoding in prose (Adyen's hex key, Braintree's base64 payload,
Shopify's "not hex"), and a bare `includes` would be satisfied by that prose and hide the drift it
exists to catch. A word-boundary header match likewise stops `x-hub-signature-256` from satisfying a
narrowed `x-hub-signature`.

It is still a **structural presence** check, and worth being precise about its limits: it cannot tell
apart two pages that share a header (github and meta both use `x-hub-signature-256`), and it does not
prove the surrounding prose is right. What it catches is engine drift — change the algorithm,
encoding or header in the registry and every page still stating the old value goes red, instead of
quietly becoming false while every other gate stays green. Proven in that direction: mutating the
registry's `encoding` and narrowing its `signatureHeader` each turn the assertion red.

### 6. Thresholds are untouched

`MIN_BODY_WORDS = 150`, `NEAR_DUP_JACCARD = 0.8`, `MIN_UNIQUE_SHINGLES = 40` do not move.

### 7. The seven thin pages earn their length

Not padding, and not a shared boilerplate paragraph — that would trip the near-duplicate half of the
same guard, and deserve to. Each page gains genuinely provider-specific substance:

- **How the signature is checked** — the exact construction, sourced from the registry's
  `RecipeDescriptor` (signed message, algorithm, encoding, key derivation, signature format), which
  is drift-pinned to the engine.
- **What breaks in practice** — the real failure modes for that provider, from that provider's own
  current documentation, cited with the date checked.

Every claim about our behaviour is checked against the registry and the engine. Every claim about a
provider's behaviour comes from that provider's own current docs. Anything that cannot be verified is
deleted rather than softened — including one already shipping: `github.mdx` asserts the `ping` event
"is signed exactly like every other event", which GitHub's documentation nowhere states.

The three pages above the floor (`stripe` 153, `braintree` 161, `meta` 171) are reviewed on the same
standard rather than left at the margin.

### 8. ADR-0129 §4 is superseded

§4's exclusion of hand-authored pages, and its conclusion that the cross-host check was "unbuyable",
are both amended: the first because its precondition is gone, the second because it was measured on
generated-vs-hand pages and then generalized to a www-vs-docs comparison that was never run.

## What this does not buy, stated plainly

An adversarial review made the strongest case against this lane, and it is worth recording rather
than burying: **on the day it merges, the 29 new manifest entries change the outcome of `pnpm lint`
in exactly zero ways.** Of the 630 pairs in the 36-page set, none reach 0.3, let alone 0.8, and after
the rewrite every page clears the floor. The `www↔www` near-dup check and the tutorial word floor
were already enforced by `apps/www/src/lib/tutorials.test.ts` using this guard's own imported code.
The net-new *comparison* is the cross-host one, whose maximum today is 0.005.

That is accepted, because the coverage was never the part that could fail — it was the part that
silently could not. The value is: the floor now applies to the ten pages that could actually breach
it (it could not before, and seven of them did); a truncated or deleted fragment now fails instead of
printing a clean summary; and the `0.91` templated-tutorial failure mode that `tutorials.ts` records
in a comment is now a standing check rather than a measurement someone took once.

Two boundaries are deliberate and should not be mistaken for oversights:

- **Scope is the provider estate**, not every page on either host. `apps/www/src/app/product/*`,
  `docs/recipes/*` and `/verify` are outside it. Subjecting general marketing and concept pages to a
  provider-page substance floor is a different decision, and a plausible one, but it is not this
  lane's and would red pages that are legitimately short. Discovery-by-glob (§2) means adding such an
  estate later costs one fragment emitter and no guard change.
- **`MIN_BODY_WORDS = 150` was not touched.** There is a real argument that the near-duplicate
  threshold, not the word floor, is the knob that measures doorway-ness, and that 0.8 is loose given
  the worst real pair is 0.29. Lowering it would be a threshold change and needs a decision, not a
  quiet edit. Recorded here as a proposal, not made.

On whether Shopify deserved 300 words: its *recipe* is unremarkable — raw-body HMAC, no quirks in the
registry — and a page that only restated the recipe would indeed have been padding. Its *integration*
is not unremarkable. Which secret signs a delivery depends on how the webhook was created, rotating
the client secret has an hour-long propagation window, and the dedup key is one of two similar
headers. Those are the three things that actually break Shopify verification, all sourced from
Shopify's own docs, and none of them derivable from the registry. That is what the page now says.

## Consequences

- A new provider page on either host cannot ship without passing the floor. That is the point.
- The cross-host comparison the ADR describes as "the only backstop" becomes real rather than stated.
- `tutorials.ts`'s 0.91-vs-0.23 property becomes continuously enforced instead of a comment.
- The manifest grows from 7 entries to 36 (20 docs + 16 www), and regenerating it becomes a required
  step when any provider page or tutorial changes.
- Hand-authored pages remain hand-authored. Their prose is their value; only their coverage changes.
