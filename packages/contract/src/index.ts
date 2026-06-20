// @webhook-co/contract — the transport-agnostic capability registry.
//
// It owns: the defineCapability registry (Zod input/output + typed error taxonomy +
// auth scope + semantics), the six wedge capabilities, the cursor-tail watermark
// contract, the closed replay TargetSchema, the RFC 9728 protected-resource-
// metadata / verifyBearer obligations, and the parity-conformance machinery.
// Every surface (api/cli/mcp/web) binds to these descriptors; none re-derives them.

export const CONTRACT_PACKAGE = "@webhook-co/contract" as const;

// NOTE on `export *` and Turbopack (Next/OpenNext) consumers: star re-exports through this barrel
// don't reliably resolve to live bindings under Turbopack (a transpiled-workspace-package + `export *`
// combination yields `undefined` for the named import at runtime — see `@webhook-co/ui/src/index.ts`,
// which uses explicit re-exports "so bundlers resolve every name reliably"). esbuild/wrangler/tsup
// consumers (api/mcp/cli/db/engine) are unaffected. A Next app that needs just one symbol should import
// the leaf subpath (e.g. `@webhook-co/contract/capability`, as `apps/web` does). If a Turbopack app ever
// needs the whole barrel, convert these `export *` lines to explicit `export { … } from` first.
export * from "./capability";
export * from "./target";
export * from "./auth";
export * from "./capabilities";
export * from "./parity";
// Explicit re-exports (not `export *`): apps/auth (a Turbopack/Next consumer) imports the consent contract,
// and the barrel note above warns `export *` can resolve to `undefined` there. Named re-exports are safe.
export {
  ConsentRequestSchema,
  ConsentDecisionSchema,
  type ConsentRequest,
  type ConsentDecision,
} from "./consent";
