/* eslint-disable security/detect-non-literal-fs-filename -- every path is a fixed literal in CLAIMS, never user input. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BESPOKE_ADAPTER_SLUGS, PROVIDER_CONFIGS, PROVIDERS } from "@webhook-co/webhooks-spec";

/**
 * Every place the product tells a reader how big the provider registry is.
 *
 * This exists because those numbers ALREADY drifted. The docs split the registry "around 109
 * config-driven / the remaining 33 bespoke" — a plausible pair that summed to the headline count and
 * matched the code in neither half (it was really 110/32). Nothing noticed, because a number typed
 * into prose has no relationship to the registry it describes. Removing the duplicate `customerio`
 * slug then moved the headline itself, and it was written out in twenty-five places.
 *
 * So the counts are pinned to the registry that generates them. The manifest holds the exact fragment
 * as it appears on the page, rebuilt from the live count — reword the sentence and this fails asking
 * you to re-point it, which is the intended cost. A count that is derived at render time (the
 * provider strip interpolates `PROVIDER_ENTRIES.length`) needs no entry here; only literals do.
 *
 * Deliberately NOT a repo-wide regex sweep for "N providers": legitimate subset claims are everywhere
 * ("18 providers share one recipe", "62 singletons lack a page"), and a pattern loose enough to catch
 * the headline catches those too. An explicit list is longer and honest.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The registry size, and the two halves the docs break it into.
 *
 * `CONFIG_DRIVEN` is NOT `Object.keys(PROVIDER_CONFIGS).length`. Twilio has both a config row and a
 * hand-written adapter, and `registry.ts` prefers the bespoke one — so its config row never runs.
 * Counting the map gives 109, which double-counts Twilio and is how the docs came to publish a split
 * that summed to one more than the registry. The halves have to be defined the way the engine
 * resolves an adapter: bespoke first, config for the rest.
 */
const TOTAL = PROVIDERS.length;
const BESPOKE = BESPOKE_ADAPTER_SLUGS.length;
const CONFIG_DRIVEN = TOTAL - BESPOKE;

interface Claim {
  readonly file: string;
  /** Built from the live counts, so the expectation cannot be typed in by hand and go stale. */
  readonly fragments: readonly string[];
}

const CLAIMS: readonly Claim[] = [
  // ---- docs.webhook.co
  { file: "apps/docs/introduction.mdx", fragments: [`**${TOTAL} providers**`] },
  { file: "apps/docs/docs.json", fragments: [`across ${TOTAL} providers`] },
  { file: "apps/docs/quickstart.mdx", fragments: [`${TOTAL} providers with their exact scheme`] },
  {
    file: "apps/docs/providers/custom.mdx",
    fragments: [`${TOTAL} listed providers`, `${TOTAL} registered providers`],
  },
  {
    file: "apps/docs/providers/verifying-provider-webhooks.mdx",
    fragments: [
      `${TOTAL}-provider registry`,
      `## The registry: ${TOTAL} providers`,
      `**${TOTAL} providers**`,
      `All ${TOTAL} providers`,
      `**${CONFIG_DRIVEN} are one declarative config row**`,
      `**${BESPOKE} are hand-written adapters**`,
    ],
  },
  {
    file: "apps/docs/providers/directory.mdx",
    fragments: [`All ${TOTAL} providers`, `**${TOTAL} providers**`],
  },
  { file: "apps/docs/guides/verify-inbound-signatures.mdx", fragments: [`**${TOTAL} providers**`] },
  {
    file: "apps/docs/guides/receive-your-first-webhook.mdx",
    fragments: [`[${TOTAL} supported providers]`],
  },
  { file: "apps/docs/guides/manage-provider-secrets.mdx", fragments: [`one of ${TOTAL}`] },
  {
    file: "apps/docs/concepts/inbound-verification.mdx",
    fragments: [
      `## ${TOTAL} providers from one registry`,
      `covering ${TOTAL} providers`,
      `Most — ${CONFIG_DRIVEN} — are config-driven`,
      `The remaining ${BESPOKE} are bespoke`,
    ],
  },
  {
    file: "apps/docs/help/getting-started/what-is-webhook-co.mdx",
    fragments: [`[${TOTAL} providers](/providers/directory)`],
  },
  // ---- webhook.co
  {
    file: "apps/www/src/components/marketing/showcases.tsx",
    fragments: [`across ${TOTAL} providers`],
  },
  {
    file: "apps/www/src/components/marketing/home-faq.ts",
    fragments: [`${TOTAL} providers are built in`],
  },
  { file: "apps/www/src/app/about/page.tsx", fragments: [`against ${TOTAL} providers`] },
  {
    file: "apps/www/src/app/product/verification/page.tsx",
    fragments: [
      `${TOTAL} providers checked at the edge`,
      `${TOTAL} providers, checked at the edge`,
      `of the ${TOTAL} providers only offer a shared token`,
    ],
  },
  { file: "apps/www/src/lib/links.ts", fragments: [`all ${TOTAL} providers`] },
  // ---- the repo's own storefront
  {
    file: "README.md",
    fragments: [`Verification for ${TOTAL} providers`, `${TOTAL}-provider registry`],
  },
];

describe("published provider counts match the registry", () => {
  it("the manifest is non-empty and every claim carries a fragment (zero-input floor)", () => {
    // Without this, deleting the list — or emptying one entry's fragments — turns the whole guard
    // into a vacuous pass over nothing.
    expect(CLAIMS.length).toBeGreaterThan(10);
    for (const c of CLAIMS) expect(c.fragments.length, `${c.file} pins nothing`).toBeGreaterThan(0);
  });

  it("the two halves the docs describe really are a partition of the registry", () => {
    // `CONFIG_DRIVEN` is a subtraction, so it sums by construction — that alone proves nothing. What
    // has to hold is that the remainder is genuinely config-served: every provider without a bespoke
    // adapter must have a config row, or the docs' second bullet is describing providers that don't
    // verify at all. (`registry.ts` throws at module load in that case; this names it in the guard.)
    const bespoke = new Set<string>(BESPOKE_ADAPTER_SLUGS);
    const remainder = PROVIDERS.filter((slug) => !bespoke.has(slug));
    expect(remainder.length).toBe(CONFIG_DRIVEN);
    const unserved = remainder.filter((slug) => PROVIDER_CONFIGS[slug] === undefined);
    expect(unserved, `providers with neither a bespoke adapter nor a config row`).toEqual([]);
    expect(BESPOKE, "non-vacuous: there is at least one hand-written adapter").toBeGreaterThan(0);
  });

  it("the provider directory lists EXACTLY the live registry — no extras, none missing", () => {
    // The strongest version of the headline claim ("All N providers"), and the check that would have
    // caught the duplicate at the source: `customerio` and `customer_io` were two rows for one brand,
    // both rendering as "Customer.io" with the same header. A count alone cannot see that — the number
    // was self-consistently wrong. Set equality can.
    const md = readFileSync(`${REPO}apps/docs/providers/directory.mdx`, "utf8");
    const listed = new Set<string>();
    for (const line of md.split("\n")) {
      if (!line.startsWith("|")) continue;
      const slug = line
        .split("|")[2]
        ?.trim()
        .match(/^`([a-z0-9_]+)`$/);
      if (slug) listed.add(slug[1]);
    }
    expect(
      listed.size,
      "parsed no slugs — the table's shape changed, re-point this",
    ).toBeGreaterThan(0);
    const live = new Set<string>(PROVIDERS);
    expect(
      [...listed].filter((s) => !live.has(s)),
      "documented but not in the registry",
    ).toEqual([]);
    expect(
      [...live].filter((s) => !listed.has(s)),
      "in the registry but undocumented",
    ).toEqual([]);
  });

  it.each(CLAIMS)("$file states the live counts", ({ file, fragments }) => {
    const content = readFileSync(`${REPO}${file}`, "utf8");
    for (const fragment of fragments) {
      expect(
        content.includes(fragment),
        `${file} no longer contains "${fragment}". Either the count moved (update the copy) or the sentence was reworded (re-point this claim).`,
      ).toBe(true);
    }
  });
});
