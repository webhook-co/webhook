import { describe, expect, it } from "vitest";
import { buildAllRecipes } from "./build-all";
import { groupByCluster, recipeClusterKey } from "./cluster";

const all = buildAllRecipes();
const bySlug = new Map(all.map((r) => [r.slug, r]));
const key = (slug: string) => {
  const r = bySlug.get(slug);
  if (!r) throw new Error(`no recipe for ${slug}`);
  return recipeClusterKey(r);
};

describe("whole-registry near-duplicate clustering", () => {
  it("groups the raw-body sha256/hex/no-prefix providers into one large cluster", () => {
    // These share a byte-identical recipe (differ only in header name) — a page for each would be thin.
    const clusters = groupByCluster(all);
    const rawHexNoPrefix = key("razorpay"); // hex | no prefix | sha256 | raw body
    const members = clusters.get(rawHexNoPrefix)!.map((r) => r.slug);
    // A representative sample of the known cluster (see internal recipe-dedup-clusters.json).
    for (const slug of ["pusher", "sentry", "linear", "dropbox", "gocardless", "asana"]) {
      expect(members).toContain(slug);
    }
    expect(members.length).toBeGreaterThan(10);
  });

  it("groups the github/meta/bitbucket/jira/notion sha256=-prefix cluster", () => {
    const gh = key("github");
    for (const slug of ["meta", "bitbucket", "atlassian_jira", "notion", "npm", "ashby"]) {
      expect(key(slug)).toBe(gh);
    }
  });

  it("keeps genuinely-distinct recipes in their own clusters", () => {
    // stripe (timestamped), shopify (base64 raw-body), hubspot (request-context), adyen (sig-in-body),
    // sendgrid (asymmetric) — all must be distinct from each other and from the raw-body-hex cluster.
    const keys = ["stripe", "shopify", "hubspot", "adyen", "sendgrid", "razorpay"].map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports how many providers are safe as standalone pages vs must be verifier-only", () => {
    const clusters = groupByCluster(all);
    const singletons = [...clusters.values()].filter((c) => c.length === 1).length;
    // Sanity floor: at least the rich archetypes yield distinct pages.
    expect(singletons).toBeGreaterThan(15);
    // And there is real collapsing happening (the raw-body long tail).
    expect(clusters.size).toBeLessThan(all.length);
  });
});
