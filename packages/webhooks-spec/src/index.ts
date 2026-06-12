// Standard Webhooks signing/verification helpers (send and receive). Do not
// hand-roll signature schemes — follow https://www.standardwebhooks.com/ (ADR-0008).
// This package is a leaf: it owns the verification union + scheme enum + the adapter
// interface, which packages/shared re-exports as the cross-surface source of truth.

export const STANDARD_WEBHOOKS_VERSION = "v1" as const;

export * from "./scheme";
export * from "./verification";
export * from "./adapter";
