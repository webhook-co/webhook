// Public surface of @webhook-co/webhooks-recipes. This barrel is PURE DATA + pure helpers: it imports
// only the generated golden (./recipes.generated), the type module (./types), and the pure clustering
// helpers (./cluster). It deliberately does NOT import ./build-recipe / ./build-all / ./bespoke-recipes,
// which pull @webhook-co/webhooks-spec (Workers libs) — so apps/www can import the recipes into its
// DOM TS program + bundle without dragging the crypto package in (the same discipline as provider-entries).

import { RECIPES } from "./recipes.generated";
import type { RecipeDescriptor } from "./types";

export { RECIPES };
export type { RecipeDescriptor, RecipeArchetype, SignatureLocation, VerifierInput } from "./types";
export { recipeClusterKey, groupByCluster } from "./cluster";

/** Index recipes by slug for O(1) lookup. */
const BY_SLUG: ReadonlyMap<string, RecipeDescriptor> = new Map(RECIPES.map((r) => [r.slug, r]));

/** Look up a provider's recipe by slug (undefined if the slug is not in the registry). */
export function getRecipe(slug: string): RecipeDescriptor | undefined {
  return BY_SLUG.get(slug);
}

/** The recipes the interactive verifier can reproduce entirely in the browser (no remote key fetch). */
export const CLIENT_VERIFIABLE_RECIPES: readonly RecipeDescriptor[] = RECIPES.filter(
  (r) => r.clientVerifiable,
);
