// Wires generated provider pages into the Mintlify nav.
//
// `scripts/docs-nav-guard.mjs` enforces both directions: every nav entry must resolve to a file, and
// every MDX file must appear in the nav (there is no allow-orphans escape hatch). So emitting a page
// and updating `docs.json` are one atomic step — a generator that wrote only the MDX would red the
// build.
//
// This function changes nothing outside the Providers group. The caller, however, round-trips
// docs.json through JSON.stringify + prettier, which normalizes formatting: a hand-collapsed object
// like `"appearance": { "default": "dark" }` comes back expanded. That is cosmetic — the values are
// untouched, and `docs-structured-data-guard.mjs` value-compares `seo.organization` field by field
// rather than byte-comparing it — but it does mean regeneration owns docs.json's layout.

/* eslint-disable @typescript-eslint/no-explicit-any -- docs.json is external JSON with no schema type here. */

const PROVIDERS_GROUP = "Providers";

/**
 * Return a copy of `docsJson` with `providers/<slug>` present in the Providers group for each slug.
 * Idempotent and order-stable, so regenerating produces byte-identical output.
 */
export function withProviderPages<T extends Record<string, any>>(
  docsJson: T,
  slugs: readonly string[],
): T {
  const next = structuredClone(docsJson) as any;
  const tabs = next?.navigation?.tabs;
  if (!Array.isArray(tabs))
    throw new Error("docs.json: navigation.tabs is missing or not an array");

  let group: any;
  for (const tab of tabs) {
    for (const g of tab?.groups ?? []) {
      if (g?.group === PROVIDERS_GROUP) group = g;
    }
  }
  if (!group)
    throw new Error(
      `docs.json: no "${PROVIDERS_GROUP}" group found — refusing to write pages nothing links to`,
    );
  if (!Array.isArray(group.pages))
    throw new Error(`docs.json: the ${PROVIDERS_GROUP} group has no pages array`);

  // Append only what is missing, in a deterministic order, so the hand-written pages keep their
  // curated ordering and a regeneration never reshuffles the sidebar.
  const existing = new Set<string>(group.pages);
  for (const slug of [...slugs].sort()) {
    const entry = `providers/${slug}`;
    if (!existing.has(entry)) {
      group.pages.push(entry);
      existing.add(entry);
    }
  }
  return next as T;
}
