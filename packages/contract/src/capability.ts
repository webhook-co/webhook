// A VALUE import, not `import type`: defineCapability narrows on `instanceof z.ZodObject` at runtime.
import { z } from "zod";

// The transport-agnostic capability registry. A capability is a typed
// descriptor — stable name, Zod input/output, typed error taxonomy, auth scope, and
// semantics — that every surface (api/cli/mcp/web) binds to identically. This is THE
// fixed contract: bindings differ, operations don't.

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

/**
 * A capability handler's typed failure, carrying a closed-taxonomy `code`. Surfaces map
 * the code to their transport (HTTP status / MCP tool error) — the single error type that
 * flows from a capability handler out to every binding, so the mapping lives in one place
 * per surface and can't drift from the taxonomy.
 */
export class CapabilityFault extends Error {
  constructor(
    readonly code: CapabilityError,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CapabilityFault";
  }
}

export interface CapabilitySemantics {
  /** Safe to retry with the same input + idempotency key (events.replay). */
  readonly idempotent?: boolean;
  /** Returns a page + nextCursor. */
  readonly paginated?: boolean;
  /** Cursor-pull tail (events.tail) — the canonical, MCP-consumable tail. */
  readonly streaming?: boolean;
  /**
   * The bounded safety-lag watermark contract: the durable tail only
   * returns rows older than now() - deltaMs, and the durable cursor never advances
   * past that. Part of the events.tail contract so every pull-tailer is gapless.
   */
  readonly watermark?: { readonly deltaMs: number };
}

/**
 * The CLOSED set of capability scopes verifyBearer can grant. A capability's scope
 * must be one of these — a typo or an unknown scope is then a compile error, not a
 * representable-but-broken descriptor. Add a scope here deliberately when a new capability
 * needs one (mirrors the closed CAPABILITY_ERRORS taxonomy above).
 */
export const CAPABILITY_SCOPES = [
  "endpoints:read",
  "endpoints:write",
  "events:read",
  "events:replay",
  // events:delete (S3) — TOMBSTONE a captured event (redact + purge its body). A DEDICATED destructive
  // scope, not events:read/replay and not a generic events:write (there is no event create/update — a
  // write scope would over-grant): deleting a customer's captured data is a materially higher privilege
  // than reading or replaying it, so a passive consumer key never holds it by accident.
  "events:delete",
  "audit:read",
  // triggers:write (S5) — manage (create/revoke) webhook→agent trigger subscriptions. A dedicated write
  // scope keeps the read scopes side-effect-free: a passive event-consumer key holds only events:read
  // (it can list + wait on triggers) and cannot mutate trigger state; managing triggers requires this.
  "triggers:write",
  "billing:read",
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/**
 * Scope NAMES reserved for future surfaces but deliberately NOT part of the closed
 * CAPABILITY_SCOPES set — nothing mints or checks them in v1, so they never widen what verifyBearer
 * can grant. `keys:manage` is the credential-management scope for future api./CLI/MCP parity on
 * key/grant administration; v1 management is session-authed on auth./app. (not token-scoped), so the
 * name is reserved only. Kept a SEPARATE export (not a 5th CAPABILITY_SCOPES member) so the closed
 * tuple — and the capability parity test that iterates it — stays closed. Lane B owns this scope SoT;
 * Lane C/D/E import the name.
 */
export const RESERVED_SCOPES = ["keys:manage"] as const;
export type ReservedScope = (typeof RESERVED_SCOPES)[number];

/**
 * `profile` — an OIDC-style IDENTITY scope, granted (unlike RESERVED_SCOPES) but NOT a capability: it binds
 * no tool on any surface, so it lives outside the closed CAPABILITY_SCOPES tuple + the parity iteration. It
 * is the consent gate for a token reading the user's own name + email (via the MCP `whoami` tool). Defined
 * here as the single source both auth. (GRANTABLE_SCOPES) and mcp (SCOPES_SUPPORTED) import, so the string
 * can't drift. See apps/auth oauth-config + apps/mcp whoami.
 */
export const PROFILE_SCOPE = "profile";

export interface CapabilityAuth {
  /** The OAuth/API-key scope verifyBearer must grant. */
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

/**
 * Fixes a capability descriptor while preserving its IO types, and makes its input STRICT.
 *
 * Zod objects strip unknown keys by default, which meant every surface accepted a field it did not
 * understand, dropped it, and answered 200. An agent that invented `eventTypes` on `triggers.create`
 * — plausible, because it IS a real field on the sibling `subscriptions.create` — got a success and
 * a trigger that ignored it. The lie was silent on the API, the CLI, the SDKs and MCP alike.
 *
 * Strictness is applied HERE rather than on each of the ~34 declarations so it cannot be forgotten by
 * the next one: every capability funnels through this call, and `cap.input.safeParse` is the single
 * parse used by all 26 handler sites, so one change covers every surface. It also changes what MCP
 * advertises — `z.toJSONSchema(input, { io: "input" })` emits `additionalProperties: false` only for
 * a strict object — so a model is told the key is illegal before it calls, instead of after.
 *
 * Deliberately a runtime narrowing, not a type-level one: `I` stays the declared schema type so
 * every existing `z.infer<typeof cap.input>` keeps resolving. Non-object inputs pass through
 * untouched — `.strict()` is meaningless on them, and silently skipping is better than throwing on a
 * shape no capability currently uses.
 */
export function defineCapability<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: CapabilityDef<I, O>,
): CapabilityDef<I, O> {
  if (!(def.input instanceof z.ZodObject)) return def;
  return { ...def, input: def.input.strict() as unknown as I };
}

export type AnyCapability = CapabilityDef;

/** The GA surfaces a capability must be bound on (its declared set, or all). */
export function requiredSurfaces(cap: AnyCapability): SurfaceId[] {
  const base = cap.surfaces ?? SURFACES;
  const exempt = new Set(Object.keys(cap.surfaceExempt ?? {}) as SurfaceId[]);
  return base.filter((s) => !exempt.has(s));
}
