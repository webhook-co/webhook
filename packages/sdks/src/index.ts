// The canonical registry of webhook.co's official client SDKs — one entry per language, all generated
// from the same OpenAPI contract (packages/openapi/src/openapi.json, served at api.webhook.co/openapi.json).
// Consumed by docs + tooling that need install commands / repositories without hard-coding them.

/** The registry a given SDK is distributed through. */
export type SdkRegistry = "npm" | "pypi" | "go";

/** A published SDK's coordinates. */
export interface SdkInfo {
  /** Human-readable language name. */
  readonly language: string;
  /** The distribution/package name on its registry. */
  readonly packageName: string;
  /** The registry it publishes to. */
  readonly registry: SdkRegistry;
  /** The one-line install command. */
  readonly install: string;
  /** The source repository URL. */
  readonly repository: string;
  /** The directory within `repository`, when the SDK lives in a monorepo. */
  readonly directory?: string;
  /** How artifact integrity is provided (honestly tiered — the registries differ). */
  readonly integrity: string;
}

/** Every official webhook.co SDK, in the order we recommend documenting them. */
export const SDKS: readonly SdkInfo[] = [
  {
    language: "TypeScript",
    packageName: "@webhook-co/sdk",
    registry: "npm",
    install: "npm install @webhook-co/sdk",
    repository: "https://github.com/webhook-co/webhook",
    directory: "packages/sdk-ts",
    integrity: "npm OIDC provenance (sigstore + Rekor + SLSA)",
  },
  {
    language: "Python",
    packageName: "webhook-co",
    registry: "pypi",
    install: "pip install webhook-co",
    repository: "https://github.com/webhook-co/webhook",
    directory: "sdks/python",
    integrity:
      "PyPI API-token publish (twine); PyPI-side hashes + PEP 740 attestations best-effort",
  },
  {
    language: "Go",
    packageName: "github.com/webhook-co/webhook-go",
    registry: "go",
    install: "go get github.com/webhook-co/webhook-go",
    repository: "https://github.com/webhook-co/webhook-go",
    integrity: "Go checksum database (sum.golang.org) + auxiliary sigstore attestation",
  },
];
