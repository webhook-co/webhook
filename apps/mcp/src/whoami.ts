// The pure core of the MCP `whoami` tool: given the caller's authenticated principal, return who they are.
// orgId + userId (if any) + scopes are ALWAYS returned (they're non-PII and identify the credential). Two
// on-demand enrichments are layered on, both best-effort (a resolver fault degrades to the base identity
// rather than failing — or hanging — the tool), and run CONCURRENTLY since they hit independent auth RPCs:
//
//   - the bound org's {id,slug,name} — resolved for EVERY principal. This is TENANT identity (which org the
//     credential acts in), not the user's personal data: it is the org's public URL handle (slug, already in
//     `/org/{slug}` links) + display name, shown to whoever authorized this credential at the consent screen.
//     Telling a bound integration which org/workspace it is connected to is the norm (Google's `hd` claim,
//     Slack/Notion workspace name) and is the whole point of this surface, so it is NOT gated on `profile`.
//     It is consistent with the REST `/v1/whoami`, which returns `organization` ungated to any credential.
//   - the user's name + email — PII, so returned ONLY when the token carries the consented `profile` scope
//     AND a userId is present. Resolved on-demand so PII stays off the hot introspection path and is exposed
//     to a third-party client only on explicit `profile` consent.
//
// I/O-free (both resolvers + the clock-bounded timeout are injected/standard), so the scope-gate, the
// concurrency, the validation, and the timeout/fallback are all unit-tested.

import {
  OrganizationSchema,
  PROFILE_SCOPE,
  type AuthContext,
  type OrgIdentity,
  type UserProfile,
} from "@webhook-co/contract";

export interface WhoamiResult {
  orgId: string;
  userId?: string;
  scopes: readonly string[];
  /** The bound org's public identity {id,slug,name} — tenant identity (see header), NOT gated on `profile`. */
  organization?: OrgIdentity;
  name?: string;
  email?: string;
}

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** Distinct from a legit `null` org row: the read didn't finish within the bound. */
const ORG_READ_TIMEOUT = Symbol("org_read_timeout");

/**
 * How long the OPTIONAL org-label read may take before it is abandoned. whoami used to answer an org-scoped
 * (no-`profile`) principal with ZERO DB access; this enrichment adds a cross-worker RPC to a tenant read, so
 * it must be bounded — a tenant-DB latency spike or pool exhaustion must degrade to the base identity, never
 * hang the tool. Cosmetic label ⇒ a short ceiling is correct.
 */
const ORG_ENRICH_TIMEOUT_MS = 2_000;

export async function buildWhoami(
  ctx: AuthContext,
  resolveProfile: (userId: string) => Promise<UserProfile | null>,
  /** Best-effort org-identity resolver (injected; opens its own tenant read on auth.). Optional/forward-compat. */
  resolveOrg?: (orgId: string) => Promise<OrgIdentity | null>,
  log?: LogFn,
  /** The org-read time bound (injectable for tests; defaults to ORG_ENRICH_TIMEOUT_MS). */
  orgTimeoutMs: number = ORG_ENRICH_TIMEOUT_MS,
): Promise<WhoamiResult> {
  // Both enrichments are independent auth RPCs — start them together so a profile-scoped user pays ONE round
  // trip of latency, not two. The profile read stays gated (PII); the org read runs for every principal.
  const orgPromise = resolveOrg
    ? enrichOrg(resolveOrg, ctx.orgId, log, orgTimeoutMs)
    : Promise.resolve(undefined);
  const wantsProfile = !!ctx.userId && ctx.scopes.includes(PROFILE_SCOPE);
  const profilePromise: Promise<UserProfile | null> = wantsProfile
    ? resolveProfile(ctx.userId!).catch(() => null) // a profile-RPC fault must not fail whoami
    : Promise.resolve(null);

  const [organization, profile] = await Promise.all([orgPromise, profilePromise]);

  const base: WhoamiResult = {
    orgId: ctx.orgId,
    scopes: ctx.scopes,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(organization ? { organization } : {}),
  };
  return wantsProfile && profile ? { ...base, name: profile.name, email: profile.email } : base;
}

/**
 * Resolve + validate the bound org's identity, bounded and never-throwing. Returns undefined (degrading to
 * the base identity) on timeout, a null/degenerate row (validated through the shared OrganizationSchema so it
 * can't drift from the wire contract), or a fault — logging a distinct signal for each so a persistent
 * org-read outage isn't invisible. (A missing binding is handled one layer out: the caller passes no resolver
 * in dev/preview, so this isn't reached and nothing is logged for the expected no-op.)
 */
async function enrichOrg(
  resolve: (orgId: string) => Promise<OrgIdentity | null>,
  orgId: string,
  log: LogFn | undefined,
  timeoutMs: number,
): Promise<OrgIdentity | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const org = await Promise.race([
      resolve(orgId),
      new Promise<typeof ORG_READ_TIMEOUT>((r) => {
        timer = setTimeout(() => r(ORG_READ_TIMEOUT), timeoutMs);
      }),
    ]);
    if (org === ORG_READ_TIMEOUT) {
      log?.("mcp.whoami_org_enrich_timeout");
      return undefined;
    }
    if (!org) {
      log?.("mcp.whoami_org_enrich_skipped", { reason: "org_not_found" });
      return undefined;
    }
    const parsed = OrganizationSchema.safeParse(org);
    if (!parsed.success) {
      log?.("mcp.whoami_org_enrich_skipped", { reason: "invalid_org" });
      return undefined;
    }
    return parsed.data;
  } catch {
    log?.("mcp.whoami_org_enrich_failed");
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
