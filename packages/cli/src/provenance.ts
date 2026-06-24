// In-CLI verification of a released binary's sigstore-signed SLSA build provenance (the DIST-7 follow-up for
// `wbhk upgrade`). The heavy sigstore work — verifying the bundle's signature/Rekor inclusion against the
// EMBEDDED public-good trust root — lives in io.ts. The SECURITY-CRITICAL, pure pieces live here so they're
// unit-tested: the pinned signer identity, and the subject-digest check that sigstore does NOT do for you
// (the verifier proves "GitHub Actions signed this statement", not "this statement is about YOUR binary" —
// without the digest check a valid attestation for a different artifact would pass).

export const PROVENANCE_REPO = "webhook-co/webhook";

// The Fulcio cert SAN (signer identity) for actions/attest-build-provenance on this repo's release workflow.
// ANCHORED (^): @sigstore/verify matches the SAN as a JS RegExp, so an un-anchored pattern would accept a
// malicious substring (e.g. a `webhook-co/webhook-evil` fork). It must be release-cli.yml at a `cli-v*` tag.
export const PROVENANCE_SAN_PATTERN =
  "^https://github\\.com/webhook-co/webhook/\\.github/workflows/release-cli\\.yml@refs/tags/cli-v";

// The OIDC issuer (GitHub Actions), pinned with exact equality — a cert from any other issuer is rejected.
export const PROVENANCE_ISSUER = "https://token.actions.githubusercontent.com";

/** GitHub's PUBLIC attestations API for an artifact digest (no auth needed for a public repo). */
export function attestationApiUrl(digestHex: string): string {
  return `https://api.github.com/repos/${PROVENANCE_REPO}/attestations/sha256:${digestHex}`;
}

/** The shape of an in-toto statement we read from a verified DSSE envelope. */
export interface InTotoStatement {
  readonly predicateType?: string;
  readonly subject?: ReadonlyArray<{ readonly digest?: { readonly sha256?: string } }>;
}

/** Decode the in-toto statement from a DSSE envelope payload. After `bundleFromJSON` the payload is the raw
 *  JSON bytes (Buffer); over the wire it's base64 — handle both so the helper is testable with either. */
export function decodeStatement(payload: Buffer | string): InTotoStatement {
  const json =
    typeof payload === "string"
      ? Buffer.from(payload, "base64").toString("utf8")
      : payload.toString("utf8");
  return JSON.parse(json) as InTotoStatement;
}

/** THE check sigstore does NOT do: confirm the verified statement actually attests THIS binary's digest.
 *  Without it, a validly-signed attestation for a DIFFERENT artifact would pass. */
export function statementCoversDigest(statement: InTotoStatement, digestHex: string): boolean {
  return (statement.subject ?? []).some((s) => s.digest?.sha256 === digestHex);
}
