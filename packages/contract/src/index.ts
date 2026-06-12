// @webhook-co/contract — the transport-agnostic capability registry.
//
// It owns: the `defineCapability` registry (Zod input/output + typed error
// taxonomy + auth scope + semantics), the six wedge capabilities, the
// cursor-tail watermark contract, the RFC 9728 protected-resource-metadata /
// obligation types, and the CI parity-conformance test. Every surface
// (api/cli/mcp/web) binds to these descriptors; none re-derives them.
//
// Real implementations land in the capability-contract step.
export const CONTRACT_PACKAGE = "@webhook-co/contract" as const;
