// Renders one provider's docs reference page (MDX) from its recipe plus a small curated block.
//
// The split matters. Everything about the CRYPTO is derived from `RecipeDescriptor`, which is itself
// derived from the verification engine — so the mechanics on the page cannot drift from the code that
// actually checks events. The only hand-written part is where the operator FINDS the credential, which
// lives in a provider's dashboard and is in no registry; each such block must cite the provider's own
// documentation, and rendering fails closed without that citation.
//
// Pages are generated only for providers whose recipe is genuinely distinct. Two providers share
// Stripe's and Slack's exact scheme (calendly, zoom), so a recipe-driven page for them is a measured
// near-duplicate (0.94 / 0.85 Jaccard) — they are excluded here and belong in the narrative tutorials.

import type { RecipeDescriptor } from "../types";

/** What the operator registers, in the provider's own vocabulary. */
export interface CuratedSecret {
  /** The provider's own product term, used verbatim as the section heading ("Signing secret"). */
  readonly credentialName: string;
  /** `public-key` schemes register the PROVIDER's public key — never call that a "secret". */
  readonly credentialKind: "secret" | "public-key";
  /** One or two sentences on where it is found, phrased as the provider's own docs phrase it. */
  readonly where: string;
  /** The provider's own documentation URL this was taken from. Required — no uncited prose ships. */
  readonly sourceUrl: string;
  /** An optional gotcha the provider's docs actually state (e.g. "shown only once"). */
  readonly note?: string;
}

export interface RenderInput {
  readonly recipe: RecipeDescriptor;
  readonly displayName: string;
  /** Mintlify frontmatter icon (a brand slug or Font Awesome name). */
  readonly icon: string;
  readonly curated: CuratedSecret;
}

/** Backtick-quote an identifier for MDX prose. */
const code = (s: string) => `\`${s}\``;

/** The signed-message / key-derivation prose the recipe already carries, trimmed of a trailing stop. */
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

function intro(r: RecipeDescriptor, name: string): string {
  // `numbered-headers` schemes send one signature per active key across a numbered series, so naming
  // only the first header would imply a single header is the whole story. Say what the engine does.
  const where =
    r.signatureLocation === "numbered-headers" && r.signatureHeader
      ? `carried across numbered ${code(r.signatureHeader.replace(/\d+$/, "N"))} headers, one per active key`
      : r.signatureHeader
        ? `carried in the ${code(r.signatureHeader)} header`
        : "carried inside the request body";
  return (
    `${name} signs each webhook with ${r.algorithm}, ${where}. Register the credential on your ` +
    `endpoint and webhook.co verifies every captured request against the exact bytes it received, ` +
    `then records the outcome — with a named reason when it fails.`
  );
}

function howItIsChecked(r: RecipeDescriptor): string {
  const lines: string[] = [
    `- **Signed message** — ${sentence(r.signedMessage)}`,
    `- **Algorithm** — ${r.algorithm}${r.encoding ? `, ${r.encoding}-encoded` : ""}.`,
    `- **Key** — ${sentence(r.keyDerivation)}`,
    `- **Signature format** — ${sentence(r.signatureFormat)}`,
  ];
  if (r.timestamp) {
    lines.push(`- **Timestamp** — read from ${sentence(r.timestamp.source)}`);
  }
  if (r.signedHeaders?.length) {
    lines.push(
      `- **Also signed** — ${r.signedHeaders.map(code).join(", ")}. These header values are folded ` +
        `into the signed message, so they must reach us unmodified.`,
    );
  }
  if (r.rotation) {
    lines.push(
      `- **Rotation** — more than one candidate signature may be present, and any one of them ` +
        `matching verifies the request. You can roll the credential without dropping events.`,
    );
  }
  return lines.join("\n");
}

function replaySection(r: RecipeDescriptor): string {
  if (!r.replayWindow.enforced) return "";
  // Claim only what holds for EVERY enforcing scheme. Some windows are two-sided (a future timestamp
  // is rejected too) but others are a one-sided TTL — Contentful rejects only stale events — so
  // "falls outside the window" would be false for those. Staleness is the common truth; where a
  // scheme does more, its own quirks say so.
  return (
    `## Replay window\n\n` +
    `Because the timestamp is signed, webhook.co enforces a ${r.replayWindow.toleranceSeconds}-second ` +
    `tolerance: a request whose signed timestamp is older than that fails verification rather than ` +
    `being accepted as a possible replay.\n\n`
  );
}

function quirksSection(r: RecipeDescriptor): string {
  if (r.quirks.length === 0) return "";
  return `## What makes this one different\n\n${r.quirks.map((q) => `- ${q}`).join("\n")}\n\n`;
}

function registerSection(slug: string, curated: CuratedSecret): string {
  const envVar = `${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${
    curated.credentialKind === "public-key" ? "PUBLIC_KEY" : "SIGNING_SECRET"
  }`;
  return `## Register it on your endpoint

<CodeGroup>

\`\`\`sh CLI
# read from a no-echo prompt (or piped stdin) — never an argv flag
printf %s "$${envVar}" | wbhk endpoints add-provider-secret <endpoint-id> \\
  --provider ${slug}
\`\`\`

\`\`\`sh API
curl https://api.webhook.co/v1/endpoints/<endpoint-id>/provider-secrets \\
  -H "Authorization: Bearer $WEBHOOK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"provider":"${slug}","secret":"<your-value>"}'
\`\`\`

\`\`\`ts TypeScript
await webhook.endpoints.providerSecrets.add({
  endpointId,
  provider: "${slug}",
  secret: process.env.${envVar}!,
});
\`\`\`

</CodeGroup>

`;
}

/**
 * Render the full MDX page. Pure and deterministic — the drift test re-renders and byte-compares, so
 * this must never reach for the clock, the filesystem, or randomness.
 */
export function renderProviderPage({ recipe, displayName, icon, curated }: RenderInput): string {
  if (!curated.sourceUrl.trim()) {
    throw new Error(
      `${recipe.slug}: curated credential block has no sourceUrl — a dashboard step must cite the provider's own documentation`,
    );
  }
  if (!curated.where.trim()) {
    throw new Error(`${recipe.slug}: curated credential block has no "where" prose`);
  }

  const noun = curated.credentialKind === "public-key" ? "public key" : "signing secret";
  const description =
    `Register your ${displayName} ${noun} on an endpoint and webhook.co verifies every inbound ` +
    `event's signature for you.`;

  return [
    `---`,
    `title: "Verify ${displayName} webhooks"`,
    `sidebarTitle: "${displayName}"`,
    `description: "${description}"`,
    `icon: "${icon}"`,
    `---`,
    ``,
    intro(recipe, displayName),
    ``,
    `## Get the ${curated.credentialName}`,
    ``,
    `${sentence(curated.where)} See ${displayName}'s own [webhook documentation](${curated.sourceUrl}) for the current steps.`,
    ...(curated.note ? [``, sentence(curated.note)] : []),
    ``,
    registerSection(recipe.slug, curated).trimEnd(),
    ``,
    `## How the signature is checked`,
    ``,
    howItIsChecked(recipe),
    ``,
    ...(replaySection(recipe) ? [replaySection(recipe).trimEnd(), ``] : []),
    ...(quirksSection(recipe) ? [quirksSection(recipe).trimEnd(), ``] : []),
    `## Confirm`,
    ``,
    "```sh",
    `wbhk events list <endpoint-id> --status verified`,
    "```",
    ``,
    `A request whose signature matches shows ${code("verified")}; one that does not shows ${code("failed")}, with the reason named.`,
    ``,
  ].join("\n");
}
