// @webhook-co/contract — the transport-agnostic capability registry.
//
// It owns: the defineCapability registry (Zod input/output + typed error taxonomy +
// auth scope + semantics), the six wedge capabilities, the cursor-tail watermark
// contract, the closed replay TargetSchema, the RFC 9728 protected-resource-
// metadata / verifyBearer obligations, and the parity-conformance machinery.
// Every surface (api/cli/mcp/web) binds to these descriptors; none re-derives them.

export const CONTRACT_PACKAGE = "@webhook-co/contract" as const;

export * from "./capability";
export * from "./target";
export * from "./auth";
export * from "./capabilities";
export * from "./parity";
