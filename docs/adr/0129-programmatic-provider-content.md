# ADR-0129: programmatic provider content — generation pipeline and placement

- **Status:** Accepted
- **Date:** 2026-07-21
- **Relates to:** AGENTS.md ("claims must not outrun the code", no thin doorway pages, brand voice),
  `packages/webhooks-spec` (the verification engine), `packages/webhooks-recipes` (#705),
  `scripts/content-dup-guard.mjs` (#706), `/verify` (#711), the generated provider pages (#712).

## Context

The provider registry describes 142 signature schemes in code. That is a genuine content asset: it is
true, it is current, and no one else has it in a machine-readable form. The obvious move is to generate
a page per provider.

Search-demand data collected before building says the obvious move is wrong. Three findings shaped
everything below.

**The per-provider verification long-tail is thin.** Only Stripe shows meaningful on-intent demand for
"verify X webhook signature". Real volume sits on head terms and on broad `{provider} webhook` queries
(Stripe 8,100; Shopify 4,400 worldwide), which are *tutorial* intent, not *reference* intent.

**Distinct recipes are far fewer than providers.** The 142 recipes collapse to 80 clusters. The largest
holds 18 providers whose schemes are byte-identical raw-body HMAC. A page per provider would therefore
restate the same recipe dozens of times with the brand name swapped — the definition of a doorway page,
and something `content-dup-guard` correctly rejects.

**Even among genuinely distinct recipes, demand is concentrated.** 62 singleton-cluster providers lack a
page, but the top ten carry 89% of the broad volume and Discord alone carries 71%. Generating the rest
would ship ~52 pages nobody searches for.

So the constraint is not "can we generate 142 pages" (we can) but "which pages are worth a reader's
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

## Consequences

- Pages cannot lie about cryptography, and cannot silently rot: drift is a test failure.
- Coverage is bounded by demand and by honest substance, so the estate stays small and each page earns
  its place. Growing it is a deliberate act requiring research, not a loop over the registry.
- Generation owns `docs.json` formatting, since the nav is rewritten through a JSON round-trip.
- Editing a generated page by hand is a build failure; edit the recipe or the curated block instead.
- The 150-word floor is a real constraint on what may be generated. If a provider cannot clear it with
  true content, it does not get a page — that is the intended outcome.
- Seven pre-existing hand-authored provider pages sit below the floor (110–147 words). They are outside
  this pipeline and unchanged by it; recording the fact here so it is a known state, not a discovery.
