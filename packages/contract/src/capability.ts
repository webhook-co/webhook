import type { z } from "zod";

// The transport-agnostic capability registry (§0.9). A capability is a typed
// descriptor — stable name, Zod input/output, typed error taxonomy, auth scope, and
// semantics — that every surface (api/cli/mcp/web) binds to identically. This is THE
// freeze: bindings differ, operations don't.

/** GA surfaces every capability must reach (constitution: CLI/API/web/MCP parity). */
export const SURFACES = ["api", "cli", "mcp", "web"] as const;
export type SurfaceId = (typeof SURFACES)[number];

/** The closed capability error taxonomy. Surfaces map these to transport status. */
export const CAPABILITY_ERRORS = [
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "ENDPOINT_PAUSED",
  "TARGET_UNREACHABLE",
] as const;
export type CapabilityError = (typeof CAPABILITY_ERRORS)[number];

export interface CapabilitySemantics {
  /** Safe to retry with the same input + idempotency key (events.replay). */
  readonly idempotent?: boolean;
  /** Returns a page + nextCursor. */
  readonly paginated?: boolean;
  /** Cursor-pull tail (events.tail) — the canonical, MCP-consumable tail. */
  readonly streaming?: boolean;
  /**
   * The bounded safety-lag watermark contract (§0.10, H5): the durable tail only
   * returns rows older than now() - deltaMs, and the durable cursor never advances
   * past that. Part of the events.tail contract so every pull-tailer is gapless.
   */
  readonly watermark?: { readonly deltaMs: number };
}

/**
 * The CLOSED set of capability scopes verifyBearer can grant (§0.8). A capability's scope
 * must be one of these — a typo or an unknown scope is then a compile error, not a
 * representable-but-broken descriptor. Add a scope here deliberately when a new capability
 * needs one (mirrors the closed CAPABILITY_ERRORS taxonomy above).
 */
export const CAPABILITY_SCOPES = [
  "endpoints:read",
  "events:read",
  "events:replay",
  "audit:read",
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export interface CapabilityAuth {
  /** The OAuth/API-key scope verifyBearer must grant (§0.8). */
  readonly scope: CapabilityScope;
}

export interface CapabilityDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly errors: readonly CapabilityError[];
  readonly auth: CapabilityAuth;
  readonly semantics: CapabilitySemantics;
  /** GA surfaces this capability must be bound on. Defaults to all SURFACES. */
  readonly surfaces?: readonly SurfaceId[];
  /** Surfaces deliberately NOT bound, each with a documented reason. */
  readonly surfaceExempt?: Partial<Record<SurfaceId, string>>;
}

/** Identity helper that fixes a capability descriptor while preserving its IO types. */
export function defineCapability<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: CapabilityDef<I, O>,
): CapabilityDef<I, O> {
  return def;
}

export type AnyCapability = CapabilityDef;

/** The GA surfaces a capability must be bound on (its declared set, or all). */
export function requiredSurfaces(cap: AnyCapability): SurfaceId[] {
  const base = cap.surfaces ?? SURFACES;
  const exempt = new Set(Object.keys(cap.surfaceExempt ?? {}) as SurfaceId[]);
  return base.filter((s) => !exempt.has(s));
}
