// The pure core of the connected-apps RPC: project a user's active OAuth grants (the provider's OAUTH_KV
// grant store) into the ConnectedApp DTO the dashboard renders. I/O-free — the provider seams (list grants,
// look up a client's name) are injected, so success/empty/lookup-miss paths are unit-tested; the getOAuthApi
// wiring is the thin handler (connected-apps-handler).
//
// Reuses the consent-screen provenance helpers so the list shows the SAME trust signals the consent screen
// did: the sanitized display name (never trusted as identity), the un-spoofable identity domain, and the
// verified/unverified status — a user can audit what they connected on the same terms they approved it.

import { clientIdentityDomain, isVerifiedClient, sanitizeClientName } from "./client-display";

import type { ConnectedApp } from "@webhook-co/contract";

/** A provider grant summary, narrowed to the fields the projection needs. */
export interface RawGrant {
  id: string;
  clientId: string;
  scope: string[];
  createdAt: number;
  expiresAt?: number;
}

export interface ListConnectedAppsDeps {
  /** List the user's active provider grants (getOAuthApi().listUserGrants → paginated). */
  listUserGrants: (userId: string) => Promise<RawGrant[]>;
  /** Resolve a client's display name (getOAuthApi().lookupClient → clientName), or null. */
  lookupClientName: (clientId: string) => Promise<string | null>;
}

/**
 * Project a user's active OAuth grants into ConnectedApp DTOs, newest first. The name is sanitized and the
 * identity domain + verified flag are derived from the client_id (a CIMD host is domain-proven; an opaque
 * DCR id has none) — the same un-spoofable signals the consent screen showed at authorization time.
 */
export async function listConnectedApps(
  deps: ListConnectedAppsDeps,
  userId: string,
): Promise<ConnectedApp[]> {
  const grants = await deps.listUserGrants(userId);
  const apps = await Promise.all(
    grants.map(async (g): Promise<ConnectedApp> => {
      const identityDomain = clientIdentityDomain(g.clientId);
      return {
        grantId: g.id,
        clientId: g.clientId,
        clientName: sanitizeClientName((await deps.lookupClientName(g.clientId)) ?? g.clientId),
        identityDomain,
        // A grant carries no redirect host, so verify on the identity domain alone — for a CIMD client that
        // is the domain-proven host; an opaque DCR client has none and shows unverified (honest).
        verified: isVerifiedClient(g.clientId, null),
        scopes: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
      };
    }),
  );
  return apps.sort((a, b) => b.createdAt - a.createdAt);
}
