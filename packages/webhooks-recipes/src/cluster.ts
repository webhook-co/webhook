// Near-duplicate clustering — PURE (imports only ./types), so www can import it without pulling
// @webhook-co/webhooks-spec (Workers libs) into its DOM TS program / bundle.

import type { RecipeDescriptor } from "./types";

/**
 * A cluster key covering everything that shapes the recipe PROSE, EXCLUDING the provider slug and the
 * signature header NAME. Two providers with the same key produce a page that differs only in the header
 * token + brand name — a thin near-duplicate. Pages must ship at most one per cluster (the highest-demand
 * one); the rest are verifier-only.
 */
export function recipeClusterKey(r: RecipeDescriptor): string {
  return JSON.stringify([
    r.archetype,
    r.algorithm,
    r.encoding ?? "",
    r.signatureValuePrefix ?? "",
    r.keyDerivation,
    r.signedMessageParts,
    r.timestamp?.format ?? "none",
    r.replayWindow.enforced,
    r.signatureFormat,
    r.signatureLocation,
    r.rotation,
  ]);
}

/** Group recipes by cluster key. */
export function groupByCluster(
  recipes: readonly RecipeDescriptor[],
): Map<string, RecipeDescriptor[]> {
  const map = new Map<string, RecipeDescriptor[]>();
  for (const r of recipes) {
    const key = recipeClusterKey(r);
    const bucket = map.get(key);
    if (bucket) bucket.push(r);
    else map.set(key, [r]);
  }
  return map;
}
