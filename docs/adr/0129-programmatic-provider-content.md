# ADR-0129: programmatic provider content — generation pipeline and placement

- **Status:** Accepted
- **Date:** 2026-07-21
- **Relates to:** AGENTS.md ("claims must not outrun the code", no thin doorway pages, brand voice),
  `packages/webhooks-spec` (the verification engine), `packages/webhooks-recipes` (#705),
  `scripts/content-dup-guard.mjs` (#706), `/verify` (#711), the generated provider pages (#712).

## Context

The provider registry describes 141 signature schemes in code. That is a genuine content asset: it is
true, it is current, and no one else has it in a machine-readable form. The obvious move is to generate
a page per provider.

Search-demand data collected before building says the obvious move is wrong. Three findings shaped
everything below.

**The per-provider verification long-tail is thin.** Only Stripe shows meaningful on-intent demand for
"verify X webhook signature". Real volume sits on head terms and on broad `{provider} webhook` queries
(Stripe 8,100; Shopify 4,400 worldwide), which are *tutorial* intent, not *reference* intent.

**Distinct recipes are far fewer than providers.** The 141 recipes collapse to 80 clusters. The largest
holds 18 providers whose schemes are byte-identical raw-body HMAC. A page per provider would therefore
restate the same recipe dozens of times with the brand name swapped — the definition of a doorway page,
and something `content-dup-guard` correctly rejects.

**Even among genuinely distinct recipes, demand is concentrated.** 62 singleton-cluster providers lack a
page, but the top ten carry 89% of the broad volume and Discord alone carries 71%. Generating the rest
would ship ~52 pages nobody searches for.

So the constraint is not "can we generate 141 pages" (we can) but "which pages are worth a reader's
time", and the answer is: far fewer than the registry size suggests, split by *intent* rather than by
provider.

## Decision

### 1. Three surfaces, one intent each

| Intent | Surface | Why there |
| --- | --- | --- |
| Reference — how this provider signs | docs `/providers/{slug}` | Belongs with the rest of the reference estate. |
| Tutorial — how to receive and test it | www `/test/{slug}` | Broad-demand, narrative; a distinct namespace from `/providers/` so the two never compete. |
| Tool — check a signature now | www `/verify` | Needs the engine as a browser import; see below. |

One canonical page per intent, cross-linked. There is no cross-domain `rel=canonical`, so the
cross-host duplicate guard is the only backstop and must stay wired.

The verifier lives on www rather than in the docs because Mintlify cannot import an npm package, so
hosting it there would mean inlining a copy of the engine — a drift risk that the whole pipeline exists
to avoid. (Not, as an earlier draft claimed, because a docs site "can't host a crypto island".)

### 2. Mechanics are generated; the human bit is curated and cited

A generated page's cryptographic claims derive from `RecipeDescriptor`, which derives from the engine.
A byte-compare drift test re-renders every page and fails on any hand-edit, so the mechanics cannot
drift from the code that verifies real events.

Exactly one thing cannot be derived: where the operator finds the credential, which lives in a
provider's dashboard. Those blocks are hand-written, kept to one or two sentences, and **must cite the
provider's own documentation** — rendering throws without a `sourceUrl`. Dashboard navigation rots, so
the page defers to the linked official page instead of reproducing a click-path we cannot keep current.

Any hand-written field that the engine can contradict must be **asserted against the engine**. The
motivating case: `credentialKind` decides whether a page says "public key" or "signing secret", and
Discord and SendGrid hand over a *public key*. Left unchecked it is free text that can publish a
falsehood about a credential while every other gate stays green, so it is bound to `recipe.archetype`.

### 3. Publish on measured demand, not on registry size

A provider earns a generated page only with (a) a distinct recipe, (b) measurable demand, and (c)
enough substance to clear the content floor honestly. Membership of the curated map *is* the published
set, so adding a provider requires researching its documentation first.

Recipe facts alone did not clear the 150-word floor for two of the first seven. That is the correct
signal, not an obstacle to route around: a page of purely machine-generated facts genuinely is thin.

Providers whose recipe duplicates another's get a **tutorial**, not a reference page — Calendly's scheme
is byte-identical to Stripe's, Zoom's to Slack's. A reference page for them would restate a scheme the
reader can already find and teach nothing new. Tutorials differentiate on setup, event types, and
gotchas, which are genuinely per-provider.

### 4. The dup-guard manifest holds only generated pages

> **Superseded 2026-07-22.** See "Amendment" below. Retained as written because the reasoning was
> sound for the state it was written in, and the amendment turns on that state having changed.

`scripts/generated/programmatic-pages.json` lists exactly what the generator emits. The guard's
substance floor applies to every entry, unmodified.

Hand-authored pages are deliberately **excluded** from it. Including them was tried and rejected: seven
sit below the floor, so carrying them meant exempting them, i.e. relaxing a live gate to accommodate
content this pipeline does not own. Scope the manifest instead, and the gate stays untouched.

The cross-check that idea was meant to buy — a generated page duplicating a hand-written one — was then
measured and found unbuyable that way. A generated Calendly page scores **0.954** against a *generated*
Stripe page but **0.037** against the *real* hand-written `stripe.mdx`: hand-written prose differs too
much for any generated page to approach the 0.8 line, so such a check could never fail. The protection
that does hold is generated-vs-generated, which the manifest already enforces — the day Stripe is
generated too, Calendly collides with it there.

**A similarity number is evidence only for the comparison it was measured on.** That is the general
lesson, and it is why this ADR quotes both figures.

### 4a. Amendment (2026-07-22): the manifest holds the whole shipped estate

The exclusion above rested on one condition: the hand-authored pages were below the floor, so carrying
them would have meant exempting them. That condition is gone. The ten hand-authored provider pages were
rewritten with provider-specific substance sourced from each provider's own current documentation and
now clear the floor on their own content, 384–559 words. The exclusion goes with the condition, and no
threshold moved.

Two things the original decision did not account for:

**The floor applied to exactly the pages that could not fail it.** Scoping the manifest to the
generator's own output made the gap self-concealing — a guard reporting "all above the substance floor"
over a set chosen to contain no failures. Seven pages sat below it for the entire life of the guard,
and §3's own closing consequence recorded them as a known state. The manifest is now enumerated from
`apps/docs/providers/` on disk, so a page cannot ship without entering it.

**The cross-host check this ADR calls "the only backstop" was never wired.** §1 says there is no
cross-domain `rel=canonical`, so the duplicate guard is the only thing standing between a docs
`/providers/{slug}` reference and its www `/test/{slug}` tutorial. The manifest contained zero www
pages; nine slugs ship on both hosts and not one pair had ever been compared. www now emits its own
fragment and the guard merges every fragment into one analysis set.

The measured conclusion in §4 stands and is worth keeping straight: hand-vs-generated really is ~0.037
and really could never fail. That was measured on *generated-vs-hand* and does not transfer to
*www-vs-docs*, which had never been measured because it had never been run. It is 0.005 today — also
too low to fire. The honest statement is that the cross-host check is prospective: `tutorials.ts`
records that templated tutorial prose measures **0.91**, over the reject line, and that number was a
one-off measurement enforced by nothing. It is now a standing check.

Guard mechanics that follow from the above:

- Fragments are **discovered** as `scripts/generated/*-pages.json` with a floor of two, not declared in
  a list. A hardcoded list would reproduce this ADR's own defect one level up.
- Coverage is verified **inside the guard**, in `pnpm lint`, against the shipped estate on disk — the
  generators' own completeness assertions run in a different gate, and "the builder enumerated
  correctly" is precisely the assumption that failed.
- A missing fragment, a fragment below the discovery floor, or a shipped page absent from the manifest
  all exit 1. Nothing is idle.
- Hand-authored pages are not drift-pinned to the engine, so their stated algorithm, encoding and
  signature header are asserted against the registry — the §2 `credentialKind` rule, applied to
  hand-authored content. The assertion is anchored to the page's `**Algorithm**` bullet and to a
  word-boundary header match, because these pages legitimately discuss a second encoding in prose and
  a substring scan would be satisfied by it. It catches registry drift, not prose errors.

Scope remains the provider estate: `apps/docs/providers/` and the www `/test/{slug}` tutorials.
`docs/recipes/*`, `apps/www/src/app/product/*` and `/verify` are outside it. Adding one later costs a
fragment emitter and no guard change.

## Consequences

- Pages cannot lie about cryptography, and cannot silently rot: drift is a test failure.
- Coverage is bounded by demand and by honest substance, so the estate stays small and each page earns
  its place. Growing it is a deliberate act requiring research, not a loop over the registry.
- Generation owns `docs.json` formatting, since the nav is rewritten through a JSON round-trip.
- Editing a generated page by hand is a build failure; edit the recipe or the curated block instead.
- The 150-word floor is a real constraint on what may be generated. If a provider cannot clear it with
  true content, it does not get a page — that is the intended outcome.
- Seven pre-existing hand-authored provider pages sat below the floor (110–147 words), outside this
  pipeline and unchanged by it. **Resolved 2026-07-22** (see §4a): rewritten with provider-specific
  substance, now 384–559 words, and inside the manifest — so the floor applies to them.
