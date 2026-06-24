import { describe, expect, it } from "vitest";

import {
  attestationApiUrl,
  decodeStatement,
  PROVENANCE_ISSUER,
  PROVENANCE_SAN_PATTERN,
  statementCoversDigest,
  type InTotoStatement,
} from "./provenance.js";

const DIGEST = "4bbb607f5daab9131a5c369706d0238b1c1bf0c5d1f3bf9eb18001d26cc17c70";

describe("attestationApiUrl", () => {
  it("targets GitHub's public attestations API for the digest", () => {
    expect(attestationApiUrl(DIGEST)).toBe(
      `https://api.github.com/repos/webhook-co/webhook/attestations/sha256:${DIGEST}`,
    );
  });
});

describe("the pinned signer identity (the spoofing defense)", () => {
  const re = new RegExp(PROVENANCE_SAN_PATTERN);

  it("matches this repo's release-cli workflow at a cli-v tag", () => {
    expect(
      re.test(
        "https://github.com/webhook-co/webhook/.github/workflows/release-cli.yml@refs/tags/cli-v0.1.2",
      ),
    ).toBe(true);
  });

  it("rejects a different repo / fork / workflow / ref (anchored, dots escaped)", () => {
    const evil = [
      "https://github.com/evil/webhook/.github/workflows/release-cli.yml@refs/tags/cli-v0.1.2",
      "https://github.com/webhook-co/webhook-evil/.github/workflows/release-cli.yml@refs/tags/cli-v1",
      "https://github.com/webhook-co/webhook/.github/workflows/evil.yml@refs/tags/cli-v1",
      "https://github.com/webhook-co/webhook/.github/workflows/release-cli.yml@refs/heads/main",
      "prefix-https://github.com/webhook-co/webhook/.github/workflows/release-cli.yml@refs/tags/cli-v1",
    ];
    for (const id of evil) expect(re.test(id)).toBe(false);
  });

  it("pins the GitHub Actions OIDC issuer", () => {
    expect(PROVENANCE_ISSUER).toBe("https://token.actions.githubusercontent.com");
  });
});

describe("decodeStatement", () => {
  const statement: InTotoStatement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha256: DIGEST } }],
  };

  it("parses a base64 (wire) payload", () => {
    const b64 = Buffer.from(JSON.stringify(statement)).toString("base64");
    expect(decodeStatement(b64).predicateType).toBe("https://slsa.dev/provenance/v1");
  });

  it("parses a raw Buffer payload (post-bundleFromJSON)", () => {
    const buf = Buffer.from(JSON.stringify(statement));
    expect(decodeStatement(buf).subject?.[0]?.digest?.sha256).toBe(DIGEST);
  });
});

describe("statementCoversDigest (the check sigstore does NOT do)", () => {
  it("is true only when the statement's subject includes this digest", () => {
    const stmt: InTotoStatement = { subject: [{ digest: { sha256: DIGEST } }] };
    expect(statementCoversDigest(stmt, DIGEST)).toBe(true);
  });

  it("is false for a different digest — a valid attestation for ANOTHER artifact must not pass", () => {
    const stmt: InTotoStatement = { subject: [{ digest: { sha256: "f".repeat(64) } }] };
    expect(statementCoversDigest(stmt, DIGEST)).toBe(false);
  });

  it("is false for an empty / missing subject", () => {
    expect(statementCoversDigest({}, DIGEST)).toBe(false);
    expect(statementCoversDigest({ subject: [] }, DIGEST)).toBe(false);
  });
});
