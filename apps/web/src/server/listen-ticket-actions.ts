"use server";

import {
  b64ToBytes,
  importListenTicketKey,
  LISTEN_SUBPROTOCOL,
  mintListenTicket,
} from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { isUuid, loadEndpoint } from "./endpoints";
import { getListenTicketKey } from "./env";
import { requireOrgAccess } from "./org-access";

// Mint a short-lived, HMAC-signed LISTEN TICKET so the dashboard can open the engine's `/listen` WebSocket
// for live events. app.webhook.co is session-cookie-authed, but `/listen` is on the cookieless wbhk.my apex
// and the browser WebSocket API can't send an Authorization header — so the browser presents this ticket via
// the WS subprotocol instead. The ticket CARRIES {orgId, endpointId} in its signed payload (the engine binds
// the tail from the verified ticket, never from the client), and is scoped read-only to the one endpoint we
// check the caller owns here. Authz = the session + an RLS-scoped endpoint-ownership check.

export type MintListenTicketResult =
  | { readonly ok: true; readonly ticket: string; readonly subprotocol: string }
  | { readonly ok: false; readonly error: string };

/**
 * Mint a listen ticket for `endpointId` after confirming the endpoint belongs to the caller's org (under
 * RLS — a cross-org / unknown id is `not_found`, indistinguishable). Returns the opaque ticket + the
 * subprotocol name; the client opens `wss://wbhk.my/listen` offering `[subprotocol, "ticket." + ticket]`.
 * The ticket itself is never logged (logActionError takes the error only).
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
      return { ok: false, error: "We couldn't start the live stream. Please try again." };
    }
    const key = await importListenTicketKey(b64ToBytes(await getListenTicketKey()));
    const ticket = await mintListenTicket(
      key,
      { orgId: session.orgId, endpointId, userId: session.userId },
      Math.floor(Date.now() / 1000),
    );
    return { ok: true, ticket, subprotocol: LISTEN_SUBPROTOCOL };
  } catch (error) {
    logActionError("listen_ticket.mint_failed", error);
    return { ok: false, error: "We couldn't start the live stream. Please try again." };
  }
}
