import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ConsentRequest } from "@webhook-co/contract";
import { b64ToBytes, readSecretBinding } from "@webhook-co/shared";

import {
  consentRequestFromTicket,
  importConsentTicketKey,
  verifyConsentTicket,
} from "@/issuer/consent-ticket";

/**
 * Import the consent-ticket HMAC key from the CONSENT_TICKET_KEY secret — the SAME decode the issuer
 * uses to sign (`importConsentTicketKey(b64ToBytes(readSecretBinding(...)))`, authorize-deps.ts), so the
 * page's key matches and a valid ticket verifies.
 */
async function consentTicketKey(): Promise<CryptoKey> {
  const { env } = await getCloudflareContext({ async: true });
  const secret = await readSecretBinding(
    (env as Record<string, unknown>).CONSENT_TICKET_KEY as Parameters<typeof readSecretBinding>[0],
  );
  return importConsentTicketKey(b64ToBytes(secret));
}

/**
 * Resolve the `?ticket=` that `/authorize` (or `/device/verify`) redirected here with into the
 * ConsentRequest the screen renders — or null when it's absent/forged/tampered/expired (the page then
 * renders the invalid-request state). The consenting userId and the sealed OAuth request never reach the
 * page; only the display fields are projected (consentRequestFromTicket), and the decision is re-checked
 * against the live session server-side at /consent/decision.
 */
export async function resolveConsentRequest(
  ticket: string | null | undefined,
): Promise<ConsentRequest | null> {
  if (!ticket) return null;
  const key = await consentTicketKey();
  const payload = await verifyConsentTicket(ticket, key, Math.floor(Date.now() / 1000));
  return payload ? consentRequestFromTicket(ticket, payload) : null;
}
