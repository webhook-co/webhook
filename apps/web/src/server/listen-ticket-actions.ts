"use server";

import {
  b64ToBytes,
  importListenTicketKey,
  LISTEN_SUBPROTOCOL,
  type ListenTicketGrant,
  mintListenTicket,
} from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { isUuid, loadEndpoint } from "./endpoints";
import { getListenTicketKey } from "./env";
import { requireOrgAccess } from "./org-access";

// Mint a short-lived, HMAC-signed LISTEN TICKET so the dashboard can open the engine's `/listen` WebSocket
// for live events. app.webhook.co is session-cookie-authed, but `/listen` is on the cookieless wbhk.my apex
// and the browser WebSocket API can't send an Authorization header — so the browser presents this ticket via
// the WS subprotocol instead. The ticket CARRIES its scope + {orgId, endpointId?} in its signed payload (the
// engine binds the tail from the verified ticket, never from the client). Two scopes: endpoint (checked owned
// here) and org (the whole org, for the consolidated events page). Authz = the session + RLS; an org tail
// names no endpoint, so RLS alone is the boundary and there is no per-endpoint ownership step.

export type MintListenTicketResult =
  | { readonly ok: true; readonly ticket: string; readonly subprotocol: string }
  | { readonly ok: false; readonly error: string };

const RETRY_ERROR = "We couldn't start the live stream. Please try again.";

/**
 * Sign a grant with the LISTEN_TICKET_KEY and wrap the result, converting any KMS/codec fault into the
 * generic retry error (the ticket itself is never logged — logActionError takes the error only). The caller
 * MUST have established the grant's scope authority before calling this.
 */
async function signGrant(grant: ListenTicketGrant): Promise<MintListenTicketResult> {
  try {
    const key = await importListenTicketKey(b64ToBytes(await getListenTicketKey()));
    const ticket = await mintListenTicket(key, grant, Math.floor(Date.now() / 1000));
    return { ok: true, ticket, subprotocol: LISTEN_SUBPROTOCOL };
  } catch (error) {
    logActionError("listen_ticket.mint_failed", error);
    return { ok: false, error: RETRY_ERROR };
  }
}

/**
 * Mint an ENDPOINT-scoped listen ticket for `endpointId` after confirming the endpoint belongs to the
 * caller's org (under RLS — a cross-org / unknown id is `not_found`, indistinguishable). Returns the opaque
 * ticket + the subprotocol name; the client opens `wss://wbhk.my/listen` offering `[subprotocol,
 * "ticket." + ticket]`.
 */
export async function mintListenTicketAction(
  slug: string,
  endpointId: string,
): Promise<MintListenTicketResult> {
  // No subPath: an action doesn't render, so there is nothing to redirect.
  const session = await requireOrgAccess(slug);
  // Runtime guard: a crafted server-action POST can deliver a non-string; a non-uuid can't name a real row.
  if (typeof endpointId !== "string" || !isUuid(endpointId)) {
    return { ok: false, error: "That endpoint no longer exists." };
  }
  try {
    const endpoint = await loadEndpoint(session.orgId, endpointId);
    if (endpoint.status === "not_found") {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    if (endpoint.status === "error") {
      return { ok: false, error: RETRY_ERROR };
    }
  } catch (error) {
    logActionError("listen_ticket.mint_failed", error);
    return { ok: false, error: RETRY_ERROR };
  }
  return signGrant({ scope: "endpoint", orgId: session.orgId, endpointId, userId: session.userId });
}

/**
 * Mint an ORG-scoped listen ticket for the consolidated events page — the whole org's endpoints on one tail.
 * There is no per-endpoint ownership check because the ticket names no endpoint: RLS already scopes every
 * tail read to `session.orgId`, so an org-scoped ticket grants nothing the caller's session didn't already
 * have. It only widens a LEAKED ticket's blast radius from one endpoint to the org's, for at most the TTL —
 * see ADR-0102's least-privilege note.
 */
export async function mintOrgListenTicketAction(slug: string): Promise<MintListenTicketResult> {
  const session = await requireOrgAccess(slug);
  return signGrant({ scope: "org", orgId: session.orgId, userId: session.userId });
}
