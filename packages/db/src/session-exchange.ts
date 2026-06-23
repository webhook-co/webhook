// Lane C A-SX-1 — the auth.→app. session-exchange store. mintSessionExchange issues a single-use,
// short-TTL, opaque ticket (`sxt_<orgId>_<secret>`) bound to the app. origin after login; consumeSession-
// Exchange atomically burns it (exactly-one-wins) at the backchannel /session/exchange redeem, returning
// the principal (userId/orgId) — the profile is read separately from the `user` row at redeem (A-SX-2).
//
// Same model as the refresh store (migration 0017/refresh-token.ts): the org is a tenant-routing hint (NOT
// a secret) embedded in the handle so the redeem stays webhook_app under RLS — no cross-org role. The
// 256-bit secret is the entropy; only its HMAC-SHA256+pepper hash (over the WHOLE plaintext, so the
// embedded org + audience binding are tamper-covered by the row's hash + audience column) is stored.

import { randomBytes, randomUUID } from "node:crypto";

import { withTenant, type Sql } from "./client";
import { CREDENTIAL_SECRET_BYTES, type CredentialHasher } from "./credential";
import { sweepExpiredSessionExchanges } from "./sweep";

const EXCHANGE_PREFIX = "sxt";
const START_LEN = 11;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintSessionExchangeInput {
  readonly orgId: string;
  /** The better-auth user id the ticket authenticates. */
  readonly userId: string;
  /** The origin the ticket may be redeemed for (e.g. https://app.webhook.co). */
  readonly audience: string;
  /** Ticket lifetime in seconds (short — the handoff happens immediately). */
  readonly ttlSeconds: number;
}

export interface MintedSessionExchange {
  /** The opaque handle — handed to the browser once for the app. redirect, never stored. */
  readonly plaintext: string;
  readonly exchangeId: string;
  readonly expiresAt: Date;
}

export interface ConsumedSessionExchange {
  readonly userId: string;
  readonly orgId: string;
  readonly audience: string;
}

/** `sxt_<orgId>_<secret>` — the org routes the tenant lookup; the secret (hashed) authenticates it. */
function makeExchangePlaintext(orgId: string): string {
  const secret = randomBytes(CREDENTIAL_SECRET_BYTES).toString("base64url");
  return `${EXCHANGE_PREFIX}_${orgId}_${secret}`;
}

/**
 * Extract the embedded org from an exchange handle. Returns null for anything not of our shape (wrong
 * prefix, missing segments, or a non-UUID org segment) — the caller treats that as an unknown ticket.
 */
export function parseSessionExchangeOrg(plaintext: string): string | null {
  const parts = plaintext.split("_");
  if (parts.length < 3 || parts[0] !== EXCHANGE_PREFIX) return null;
  const orgId = parts[1];
  return orgId && UUID_RE.test(orgId) ? orgId : null;
}

/** Issue a fresh single-use exchange ticket bound to a user + the app. origin (called after login). */
export async function mintSessionExchange(
  app: Sql,
  input: MintSessionExchangeInput,
  hasher: CredentialHasher,
): Promise<MintedSessionExchange> {
  const plaintext = makeExchangePlaintext(input.orgId);
  const id = randomUUID();
  const expiresAt = await withTenant(app, input.orgId, async (tx) => {
    const [row] = await tx<{ expires_at: Date }[]>`
      insert into auth_session_exchange
        (id, org_id, user_id, audience, token_hash, prefix, start, expires_at)
      values
        (${id}, ${input.orgId}, ${input.userId}, ${input.audience}, ${hasher.hash(plaintext)},
         ${EXCHANGE_PREFIX}, ${plaintext.slice(0, START_LEN)}, now() + make_interval(secs => ${input.ttlSeconds}))
      returning expires_at`;
    if (!row) throw new Error("mintSessionExchange: insert returned no row");
    return row.expires_at;
  });
  return { plaintext, exchangeId: id, expiresAt };
}

/**
 * Atomically consume an exchange ticket. Returns the principal (userId/orgId/audience), or null if the
 * ticket is unknown / already used / expired, OR its audience does not match `expectedAudience` (a ticket
 * minted for one origin can't be redeemed by another — and a mismatch does NOT burn it, so the legitimate
 * redeemer's ticket survives a wrong-origin probe). The single-use gate is the one UPDATE…used_at below: a
 * concurrent replay loses the row lock and matches no row, so exactly one redemption wins. Loops
 * candidates() (current + previous peppers) so a ticket survives a pepper rotation (mirrors the api-key
 * verify path), though tickets are short-lived so a straddling rotation is unlikely.
 */
export async function consumeSessionExchange(
  app: Sql,
  plaintext: string,
  hasher: CredentialHasher,
  expectedAudience: string,
): Promise<ConsumedSessionExchange | null> {
  const orgId = parseSessionExchangeOrg(plaintext);
  if (!orgId) return null;
  const result = await withTenant(app, orgId, async (tx) => {
    for (const candidate of hasher.candidates(plaintext)) {
      const [consumed] = await tx<{ user_id: string; audience: string }[]>`
        update auth_session_exchange set used_at = now()
        where token_hash = ${candidate}
          and used_at is null and expires_at > now()
          and audience = ${expectedAudience}
        returning user_id, audience`;
      if (consumed) return { userId: consumed.user_id, orgId, audience: consumed.audience };
    }
    return null;
  });

  // Housekeeping: after the redeem transaction has COMMITTED, opportunistically prune this org's expired
  // tickets in a separate, best-effort transaction (errors swallowed inside the sweep), so it can never
  // roll back or fail the redeem above. Skipped when nothing was consumed (a wrong-origin/expired probe
  // does no real work to piggyback on).
  if (result) await sweepExpiredSessionExchanges(app, orgId);
  return result;
}
