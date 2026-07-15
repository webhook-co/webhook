// The pure core of the connected-apps RPC: project a user's active OAuth grants (the provider's OAUTH_KV
// grant store) into the ConnectedApp DTO the dashboard renders. I/O-free — the provider seams (list grants,
// look up a client's name) are injected, so success/empty/lookup-miss paths are unit-tested; the getOAuthApi
// wiring is the thin handler (connected-apps-handler).
//
// Reuses the consent-screen provenance helpers so the list shows the SAME trust signals the consent screen
// did: the sanitized display name (never trusted as identity), the un-spoofable identity domain, and the
// verified/unverified status — a user can audit what they connected on the same terms they approved it.

import { clientIdentityDomain, isVerifiedClient, sanitizeClientName } from "./client-display";

import type { ConnectedApp, OrgIdentity } from "@webhook-co/contract";

/** A provider grant summary, narrowed to the fields the projection needs. */
export interface RawGrant {
  id: string;
  clientId: string;
  scope: string[];
  createdAt: number;
  expiresAt?: number;
  /** The org the grant is bound to (from the grant's metadata.orgId). Absent for a legacy grant. */
  orgId?: string;
}

export interface ListConnectedAppsDeps {
  /** List the user's active provider grants (getOAuthApi().listUserGrants → paginated). */
  listUserGrants: (userId: string) => Promise<RawGrant[]>;
  /** Resolve a client's display name (getOAuthApi().lookupClient → clientName), or null. */
  lookupClientName: (clientId: string) => Promise<string | null>;
  /**
   * Resolve an org's {id,slug,name} from its id — used to show which org each grant is bound to. Optional
   * (a legacy grant carries no orgId); best-effort, so a null/failed read just omits the org.
   */
  resolveOrgIdentity?: (orgId: string) => Promise<OrgIdentity | null>;
}

/**
 * Project a user's active OAuth grants into ConnectedApp DTOs, newest first. The name is sanitized and the
 * identity domain + verified flag are derived from the client_id (a CIMD host is domain-proven; an opaque
 * DCR id has none) — the same un-spoofable signals the consent screen showed at authorization time.
 */
/** Abandon a stalled org read after this so an unresponsive tenant DB can't hang the whole Connected Apps
 *  list — it degrades to "unknown org" instead. The reads are supplementary display enrichment. */
const ORG_ENRICH_TIMEOUT_MS = 3_000;
const ORG_READ_TIMEOUT = Symbol("org_read_timeout");

export async function listConnectedApps(
  deps: ListConnectedAppsDeps,
  userId: string,
  orgTimeoutMs: number = ORG_ENRICH_TIMEOUT_MS,
): Promise<ConnectedApp[]> {
  const grants = await deps.listUserGrants(userId);
  // Resolve each grant's bound org, deduped by orgId (a user's grants are usually in the same org, so this
  // collapses N grants → one read per distinct org). Best-effort AND bounded: a null / rejecting / HANGING
  // read leaves `org` undefined rather than stalling the list.
  const orgCache = new Map<string, Promise<OrgIdentity | undefined>>();
  const resolveOrg = async (orgId: string | undefined): Promise<OrgIdentity | undefined> => {
    if (orgId === undefined || !deps.resolveOrgIdentity) return undefined;
    let pending = orgCache.get(orgId);
    if (pending === undefined) {
      const resolve = deps.resolveOrgIdentity;
      pending = (async (): Promise<OrgIdentity | undefined> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const org = await Promise.race([
            resolve(orgId),
            new Promise<typeof ORG_READ_TIMEOUT>((r) => {
              timer = setTimeout(() => r(ORG_READ_TIMEOUT), orgTimeoutMs);
            }),
          ]);
          return org === ORG_READ_TIMEOUT ? undefined : (org ?? undefined);
        } catch {
          return undefined;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      orgCache.set(orgId, pending);
    }
    return pending;
  };
  const apps = await Promise.all(
    grants.map(async (g): Promise<ConnectedApp> => {
      const identityDomain = clientIdentityDomain(g.clientId);
      const [clientName, org] = await Promise.all([
        deps.lookupClientName(g.clientId),
        resolveOrg(g.orgId),
      ]);
      return {
        grantId: g.id,
        clientId: g.clientId,
        clientName: sanitizeClientName(clientName ?? g.clientId),
        identityDomain,
        // A grant carries no redirect host, so verify on the identity domain alone — for a CIMD client that
        // is the domain-proven host; an opaque DCR client has none and shows unverified (honest).
        verified: isVerifiedClient(g.clientId, null),
        scopes: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        ...(org ? { org } : {}),
      };
    }),
  );
  return apps.sort((a, b) => b.createdAt - a.createdAt);
}
