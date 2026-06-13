// @webhook-co/shared — the single home for cross-surface types and pure helpers.
// Runtime-DB-free (no `pg`): web/cli/mcp import types here without pulling in the
// database client. The verification union + scheme enum + adapter interface live in
// webhooks-spec and are re-exported here so there is one import site for every surface.

export const SERVICE_NAME = "webhook" as const;

export * from "@webhook-co/webhooks-spec";

export * from "./enums";
export * from "./ids";
export * from "./entities";
export * from "./watermark";
export * from "./cursor";
export * from "./audit";
export * from "./audit-chain";
export * from "./r2";
export * from "./envelope";
export * from "./kms/local";
export * from "./kms/lru";
export * from "./secret-store";
export * from "./redaction";
export * from "./metering";
