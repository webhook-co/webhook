import { requiredSurfaces, SURFACES, type AnyCapability, type SurfaceId } from "./capability";

// The parity-conformance check: every capability must be bound on each GA
// surface it requires, or be explicitly surfaceExempt with a reason. This is the
// machinery; each surface package registers its real bindings and a CI test calls
// assertCapabilityParity with them. Parity is a check, not a hope.

/** What a surface implements: the set of capability names it has bound. */
export type SurfaceBindings = Readonly<Record<SurfaceId, ReadonlySet<string>>>;

export interface ParityViolation {
  readonly capability: string;
  readonly surface: SurfaceId;
}

/** Returns every (capability, surface) pair that is required but not bound. */
export function findParityViolations(
  capabilities: readonly AnyCapability[],
  bindings: SurfaceBindings,
): ParityViolation[] {
  const violations: ParityViolation[] = [];
  for (const cap of capabilities) {
    for (const surface of requiredSurfaces(cap)) {
      if (!bindings[surface]?.has(cap.name)) {
        violations.push({ capability: cap.name, surface });
      }
    }
  }
  return violations;
}

/** Throws a readable error if any required binding is missing. */
export function assertCapabilityParity(
  capabilities: readonly AnyCapability[],
  bindings: SurfaceBindings,
): void {
  const violations = findParityViolations(capabilities, bindings);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  - ${v.capability} is not bound on ${v.surface}`);
    throw new Error(`capability parity violations:\n${lines.join("\n")}`);
  }
}

/** Convenience: an empty bindings map (each surface implements nothing yet). */
export function emptyBindings(): Record<SurfaceId, Set<string>> {
  return Object.fromEntries(SURFACES.map((s) => [s, new Set<string>()])) as Record<
    SurfaceId,
    Set<string>
  >;
}
