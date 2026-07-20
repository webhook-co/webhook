// Derive a human-facing RecipeDescriptor from a config-driven provider's `HmacProviderConfig`.
// This mirrors, field-for-field, how `makeHmacAdapter` (webhooks-spec/adapters/factory.ts) RESOLVES
// the config at verify time — so the recipe cannot claim anything the engine doesn't do. In
// particular the replay window is derived EXACTLY as the factory computes it
// (`ts !== null && enforceWindow`), never from the presence of a `toleranceSeconds` value.

import type {
  HmacProviderConfig,
  MessagePart,
  SignatureFormat,
  TimestampSource,
} from "@webhook-co/webhooks-spec";
import type { RecipeArchetype, RecipeDescriptor, VerifierInput } from "./types";
export { recipeClusterKey, groupByCluster } from "./cluster";

/** Machine token per message part — used for near-duplicate clustering and rendering. */
function partToken(part: MessagePart): string {
  switch (part.kind) {
    case "body":
      return "body";
    case "timestamp":
      return "timestamp";
    case "literal":
      return `literal:${part.value}`;
    case "method":
      return "method";
    case "url":
      return `url:${part.component}`;
    case "queryParam":
      return `queryParam:${part.name}`;
    case "formField":
      return `formField:${part.name}`;
    case "sortedFormFields":
      return "sortedFormFields";
    case "header":
      return `header:${part.header}`;
    case "jsonField":
      return `jsonField:${part.path}`;
    case "conditionalField":
      return `conditionalField:${part.source.kind}`;
  }
}

/** Human token per message part, for the one-line "what is signed" string. */
function partHuman(part: MessagePart): string {
  switch (part.kind) {
    case "body":
      return "{body}";
    case "timestamp":
      return "{timestamp}";
    case "literal":
      return part.value;
    case "method":
      return "{method}";
    case "url":
      return part.component === "path" ? "{url-path}" : "{url}";
    case "queryParam":
      return `{query:${part.name}}`;
    case "formField":
      return `{form:${part.name}}`;
    case "sortedFormFields":
      return "{sorted-form-fields}";
    case "header":
      return `{${part.header}}`;
    case "jsonField":
      return `{${part.path}}`;
    case "conditionalField":
      return `{${part.source.kind === "queryParam" ? part.source.name : part.source.header}?}`;
  }
}

function renderKeyDerivation(mode: HmacProviderConfig["keyDerivation"]): string {
  switch (mode ?? "utf8") {
    case "utf8":
      return "the signing secret used verbatim (its UTF-8 bytes)";
    case "whsec-base64":
      return "the Standard Webhooks secret with any `whsec_` prefix stripped, then base64-decoded to raw key bytes";
    case "hex":
      return "the signing key hex-decoded to raw bytes (not used as its ASCII characters)";
    case "sha1-secret":
      return "the SHA-1 digest (raw 20 bytes) of the private key, not the key itself";
  }
}

function renderSignatureFormat(format: SignatureFormat, prefix: string | undefined): string {
  switch (format.kind) {
    case "plain":
      return prefix !== undefined
        ? `the encoded MAC behind a required \`${prefix}\` prefix`
        : "the bare encoded MAC";
    case "csvKv":
      return `\`${format.sigKey}=\` field(s) in a ${format.delimiter === ";" ? "semicolon" : "comma"}-separated list${
        format.groupDelimiter !== undefined ? " (space-grouped for rotation)" : ""
      }`;
    case "spaceList":
      return `space-separated \`${format.sigTag},<sig>\` entries (Standard Webhooks)`;
    case "delimitedList":
      return `a \`${format.delimiter}\`-separated list of signatures (rotation)`;
    case "positional":
      return "a comma-separated list: the timestamp first, then the signature(s)";
    case "pipePairs":
      return "`&`-joined `publicKey|signature` pairs";
  }
}

function renderTimestampSource(ts: TimestampSource): string {
  if (ts.kind === "none") return "";
  if (ts.kind === "header") return `the \`${ts.header}\` header`;
  return `the \`${ts.field}=\` field in the signature header`;
}

function classifyArchetype(
  config: HmacProviderConfig,
  parts: readonly MessagePart[],
): RecipeArchetype {
  if (config.signatureSource) return "sig-in-body-hmac";
  const format = config.signatureFormat ?? { kind: "plain" as const };
  if (format.kind === "spaceList") return "standard-webhooks";
  const requestContext = parts.some(
    (p) =>
      p.kind === "method" ||
      p.kind === "url" ||
      p.kind === "queryParam" ||
      p.kind === "formField" ||
      p.kind === "sortedFormFields" ||
      p.kind === "conditionalField",
  );
  if (requestContext) return "request-context-hmac";
  if ((config.timestamp ?? { kind: "none" }).kind !== "none") return "timestamped-hmac";
  return "raw-body-hmac";
}

/** Precise, parts-derived description of the request context a request-context scheme binds. */
function requestContextQuirk(parts: readonly MessagePart[]): string | null {
  const signsMethod = parts.some((p) => p.kind === "method");
  const signsFullUrl = parts.some((p) => p.kind === "url" && p.component === "full");
  const signsUrlPath = parts.some((p) => p.kind === "url" && p.component === "path");
  const signsQuery = parts.some(
    (p) =>
      p.kind === "queryParam" || (p.kind === "conditionalField" && p.source.kind === "queryParam"),
  );
  const signsForm = parts.some((p) => p.kind === "sortedFormFields" || p.kind === "formField");
  const bound: string[] = [];
  if (signsMethod) bound.push("the HTTP method");
  if (signsFullUrl) bound.push("the full request URL");
  else if (signsUrlPath) bound.push("the request URL path");
  else if (signsQuery) bound.push("specific request query parameter(s)");
  if (signsForm) bound.push("the URL-encoded form fields");
  if (bound.length === 0) return null;
  const list =
    bound.length === 1
      ? bound[0]
      : bound.slice(0, -1).join(", ") + " and " + bound[bound.length - 1];
  const urlNote =
    signsFullUrl || signsUrlPath || signsQuery
      ? " — so the exact ingest URL must match what the provider signed"
      : "";
  return `Verification binds ${list}${urlNote}.`;
}

function deriveQuirks(
  config: HmacProviderConfig,
  parts: readonly MessagePart[],
  replayEnforced: boolean,
  archetype: RecipeArchetype,
): string[] {
  const quirks: string[] = [];
  const digest = config.digest ?? "sha256";
  if (digest !== "sha256")
    quirks.push(`Signs with HMAC-${digest.toUpperCase()}, not the more common SHA-256.`);
  const key = config.keyDerivation ?? "utf8";
  if (key === "hex")
    quirks.push(
      "The signing key is hex-decoded to raw bytes before HMAC — not used as UTF-8 characters.",
    );
  if (key === "sha1-secret")
    quirks.push("The HMAC key is the SHA-1 digest of the private key, not the key itself.");
  if (config.encoding === "base64url")
    quirks.push("The MAC is base64url-encoded (URL-safe alphabet).");
  if (config.signatureSource)
    quirks.push("The signature travels inside the request body, not in a header.");
  if (archetype === "request-context-hmac") {
    const rc = requestContextQuirk(parts);
    if (rc) quirks.push(rc);
  }
  if (config.rejectSignedMessageMatching !== undefined)
    quirks.push(
      "An anti-oracle guard rejects handshake-domain messages even under an otherwise-valid key.",
    );
  if (config.numberedSignatureHeaders || config.additionalSignatureHeaders)
    quirks.push(
      "Multiple signature headers may be present during key rotation; any one matching verifies.",
    );
  const timestamped = (config.timestamp ?? { kind: "none" }).kind !== "none";
  if (timestamped && !replayEnforced)
    quirks.push(
      "The timestamp is part of the signed message, but no replay-age window is enforced.",
    );
  return quirks;
}

function deriveVerifierInputs(
  config: HmacProviderConfig,
  parts: readonly MessagePart[],
  location: RecipeDescriptor["signatureLocation"],
): VerifierInput[] {
  const inputs: VerifierInput[] = ["secret", "payload"];
  if (location === "header" || location === "numbered-headers") inputs.push("signatureHeader");
  const ts = config.timestamp ?? { kind: "none" };
  if (ts.kind === "header") inputs.push("timestamp");
  if (
    parts.some(
      (p) =>
        p.kind === "url" ||
        p.kind === "queryParam" ||
        (p.kind === "conditionalField" && p.source.kind === "queryParam"),
    )
  )
    inputs.push("requestUrl");
  if (parts.some((p) => p.kind === "method")) inputs.push("method");
  return inputs;
}

export function buildRecipe(config: HmacProviderConfig): RecipeDescriptor {
  const parts: readonly MessagePart[] = config.message ?? [{ kind: "body" }];
  const format = config.signatureFormat ?? { kind: "plain" as const };
  const ts = config.timestamp ?? { kind: "none" as const };
  const digest = config.digest ?? "sha256";
  // EXACT factory logic (factory.ts:399): enforce ⟺ a timestamp resolves AND enforceWindow.
  const replayEnforced = ts.kind !== "none" && (config.enforceReplayWindow ?? true);
  const archetype = classifyArchetype(config, parts);

  const signatureLocation: RecipeDescriptor["signatureLocation"] = config.signatureSource
    ? config.signatureSource.kind === "jsonField"
      ? "json-body"
      : "form-body"
    : config.numberedSignatureHeaders
      ? "numbered-headers"
      : "header";

  const signatureHeader = config.signatureHeader === "" ? null : config.signatureHeader;

  const signedMessageParts = parts.map(partToken);
  // Header values (other than the signature/timestamp headers) that are folded into the signed message
  // and so must ALSO be collected to reconstruct it — Standard Webhooks' webhook-id, ConfigCat's
  // id/timestamp headers, Sinch's nonce, etc. Deduped, in first-seen order.
  const signedHeaders = [...new Set(parts.flatMap((p) => (p.kind === "header" ? [p.header] : [])))];
  const isRawBody = signedMessageParts.length === 1 && signedMessageParts[0] === "body";
  const signedMessage = isRawBody
    ? "the raw request body"
    : "`" + parts.map(partHuman).join("") + "`";

  const rotation =
    format.kind !== "plain" ||
    config.additionalSignatureHeaders !== undefined ||
    config.numberedSignatureHeaders !== undefined;

  return {
    slug: config.slug,
    archetype,
    source: "config",
    signatureLocation,
    signatureHeader,
    ...(config.additionalSignatureHeaders
      ? { additionalSignatureHeaders: config.additionalSignatureHeaders }
      : {}),
    ...(config.signatureValuePrefix !== undefined
      ? { signatureValuePrefix: config.signatureValuePrefix }
      : {}),
    signatureFormat: renderSignatureFormat(format, config.signatureValuePrefix),
    algorithm: `HMAC-${digest.toUpperCase()}`,
    encoding: config.encoding,
    keyDerivation: renderKeyDerivation(config.keyDerivation),
    signedMessage,
    signedMessageParts,
    timestamp:
      ts.kind === "none"
        ? null
        : { source: renderTimestampSource(ts), format: ts.format ?? "seconds" },
    replayWindow: { enforced: replayEnforced, toleranceSeconds: config.toleranceSeconds },
    rotation,
    clientVerifiable: true,
    verifierInputs: deriveVerifierInputs(config, parts, signatureLocation),
    ...(signedHeaders.length > 0 ? { signedHeaders } : {}),
    quirks: deriveQuirks(config, parts, replayEnforced, archetype),
  };
}
