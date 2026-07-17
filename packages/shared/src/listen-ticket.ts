import {
  b64urlToBytes,
  bytesToB64url,
  importHmacKey,
  timingSafeEqual,
  utf8Decoder,
  utf8Encoder,
} from "./bytes";

// The live-events listen ticket — a short-lived, HMAC-signed grant that lets the DASHBOARD open the
// engine's `GET /listen` WebSocket without an api-key bearer. The dashboard lives on app.webhook.co
// (session cookie); `/listen` is on the cookieless wbhk.my apex, and the browser WebSocket API can't send
// an Authorization header. So a session-authed web action mints this ticket (after checking the endpoint
// belongs to the caller's org under RLS) and the browser presents it via the WebSocket subprotocol; the
// engine verifies it + an Origin allowlist. Because the browser controls the query string and can't send a
// header, the ticket CARRIES the org + endpoint in its signed payload — the engine derives the DO binding
// from the verified ticket, never from the client. Codec mirrors the MCP session-binding / cursor envelope:
// `<base64url(json)>.<base64url(mac)>`, MAC = first 16 bytes of HMAC-SHA256. Read-only (`events.tail`).

const HMAC_BYTES = 16; // 128-bit truncated HMAC-SHA256 tag (matches the session-binding / cursor codec).
const LISTEN_TICKET_KEY_BYTES = 32; // a dedicated 32-byte secret (LISTEN_TICKET_KEY), shared engine↔web.

/**
 * The WebSocket subprotocol the dashboard live-events client OFFERS and the engine ECHOES on the 101.
 * Single-sourced here so the mint (web) and verify/echo (engine) sides can never drift — a browser aborts
 * the handshake unless the server accepts exactly one of the subprotocols the client offered. Bump this in
 * lockstep with any wire change (paired with LISTEN_TICKET_VERSION).
 */
export const LISTEN_SUBPROTOCOL = "wbhk.listen.v1";

/**
 * The subprotocol token prefix carrying the base64url ticket, e.g. `ticket.<token>`. The client offers
 * `[LISTEN_SUBPROTOCOL, LISTEN_TICKET_SUBPROTOCOL_PREFIX + ticket]`; the engine pulls the ticket back off
 * this prefix. Kept OUT of the URL/query (privacy — query strings are logged).
 */
export const LISTEN_TICKET_SUBPROTOCOL_PREFIX = "ticket.";

/**
 * The current envelope version. `verifyListenTicket` rejects any envelope whose `v` is missing or != this.
 *
 * Stays **1** across the slice-9 scope addition: the `s` scope discriminator is ADDITIVE, exactly like `u`
 * before it. An endpoint ticket omits `s` entirely, so it is byte-identical to a pre-scope v1 ticket — a
 * rolling web/engine deploy therefore NEVER 401s the shipped endpoint live-events feature (old engine
 * verifies new web's endpoint tickets and vice-versa). A version bump would have reintroduced exactly the
 * deploy-window 401 that keeping `u` additive was written to avoid. Safety is preserved without a bump
 * because absence defaults to the NARROWER endpoint scope: only an explicit, signed `s:"org"` ever widens,
 * and forging that needs the HMAC key. (Org tickets ARE understood only by a new engine, but the org feature
 * is new too — no old client mints them, and its own first rollout self-heals.)
 */
export const LISTEN_TICKET_VERSION = 1;

/**
 * Ticket lifetime (seconds). Kept SHORT — the ticket only has to survive the round-trip from mint to the
 * WebSocket handshake, so a leaked ticket is replayable for at most this window (read-only tailing of exactly
 * the scope it names). `mintListenTicket` stamps `exp = nowSeconds + this`.
 */
export const LISTEN_TICKET_TTL_SECONDS = 60;

/**
 * The scope a ticket authorizes: one named endpoint, or the caller's whole org. Org scope is what the
 * consolidated org-wide events page tails; RLS already scopes every read to the org, so an org-scoped ticket
 * grants zero authority the caller's session didn't already have — it only widens a leaked ticket's blast
 * radius from one endpoint to the org's endpoints, for at most the TTL.
 */
export type ListenTicketScope = "org" | "endpoint";

/** The signed grant: version + org + scope (+ endpoint iff endpoint-scoped) + user + expiry. */
interface ListenTicketEnvelope {
  /** Envelope version — must equal LISTEN_TICKET_VERSION to verify. */
  v: number;
  /** The org the ticket authorizes (set from the minting session, never the client). */
  o: string;
  /**
   * The scope discriminator. OPTIONAL and ADDITIVE: absent or "endpoint" → endpoint scope (so a legacy /
   * endpoint ticket with no `s` is byte-identical to a v1 ticket); "org" → org scope; any OTHER value → null.
   * Absence defaults to the NARROWER endpoint scope and still requires an endpoint — it never grants org.
   */
  s?: ListenTicketScope;
  /**
   * The endpoint the ticket authorizes tailing (validated to belong to `o` at mint time). Present for endpoint
   * scope (incl. an `s`-less endpoint ticket); an org-scoped envelope MUST omit it, and an `s:"org"`/`e`
   * disagreement is rejected.
   */
  e?: string;
  /**
   * The user the ticket was minted for (from the minting session, never the client). OPTIONAL within a
   * version: a mint that omits it verifies fine and the engine falls back to the lifetime cap (no membership
   * re-check); a mint that carries it enables the periodic re-check. Forging a userless ticket to EVADE the
   * check is impossible — minting requires the HMAC key.
   */
  u?: string;
  /** Unix seconds — the ticket is dead strictly after this (now > exp). */
  exp: number;
}

/**
 * The verified grant returned to the engine — a discriminated union on `scope`, so `endpointId` is provably
 * present exactly when the ticket is endpoint-scoped (the engine must branch, and can't read a phantom
 * endpoint off an org grant).
 */
export type ListenTicketGrant =
  | {
      readonly scope: "endpoint";
      readonly orgId: string;
      readonly endpointId: string;
      /** Present on a current mint; absent on a userless ticket (then only the lifetime cap applies). */
      readonly userId?: string;
    }
  | {
      readonly scope: "org";
      readonly orgId: string;
      readonly userId?: string;
    };

/**
 * Import raw key bytes as a non-extractable HMAC key. LISTEN_TICKET_KEY is a dedicated 32-byte secret,
 * byte-identical in the engine (verify) and web (mint); reject any other length so a misconfigured or
 * truncated key fails loud at construction rather than silently minting unverifiable tickets.
 */
export async function importListenTicketKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== LISTEN_TICKET_KEY_BYTES) {
    throw new Error(
      `LISTEN_TICKET_KEY must be ${LISTEN_TICKET_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return importHmacKey(raw);
}

async function tag(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  // The cast bridges the node-lib Uint8Array vs DOM WebCrypto BufferSource types (the same crypto.subtle
  // friction the session-binding / db code hits — see the tsconfig-boundary note); no runtime effect.
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>),
  );
  return sig.slice(0, HMAC_BYTES);
}

/**
 * Mint a signed listen ticket for the given scope with an expiry `nowSeconds + LISTEN_TICKET_TTL_SECONDS`.
 * `nowSeconds` is the injected clock (Unix seconds) so the codec stays pure and the expiry is
 * deterministically testable. The caller (a session-authed web action) MUST have verified the org/endpoint
 * belongs to the caller before minting — this codec signs whatever it's given. An endpoint-scoped grant
 * writes `e`; an org-scoped grant omits it entirely (the discriminated union makes that a compile-time fact).
 */
export async function mintListenTicket(
  key: CryptoKey,
  grant: ListenTicketGrant,
  nowSeconds: number,
): Promise<string> {
  const env: ListenTicketEnvelope = {
    v: LISTEN_TICKET_VERSION,
    o: grant.orgId,
    // Endpoint tickets OMIT `s` → byte-identical to a pre-scope v1 ticket, so a rolling deploy never 401s the
    // shipped endpoint feature. Only org tickets carry the widening `s:"org"`.
    ...(grant.scope === "org" ? { s: "org" } : { e: grant.endpointId }),
    ...(grant.userId ? { u: grant.userId } : {}),
    exp: nowSeconds + LISTEN_TICKET_TTL_SECONDS,
  };
  const bytes = utf8Encoder.encode(JSON.stringify(env));
  const mac = await tag(key, bytes);
  return `${bytesToB64url(bytes)}.${bytesToB64url(mac)}`;
}

/**
 * Verify a listen ticket and return its scope-discriminated grant ONLY when the MAC recomputes AND the
 * envelope is the current version AND it has not expired (`nowSeconds <= exp`, inclusive) AND its scope +
 * endpoint agree. Any malformed, tampered, forged, wrong-key, stale-version, expired, or shape-inconsistent
 * ticket returns null (never throws) — the cases are indistinguishable to the caller (no oracle).
 *
 * Scope safety — "absence never grants ORG": `s` is optional and ADDITIVE. Absent or "endpoint" → endpoint
 * scope, which still REQUIRES a non-empty `e`; "org" → org scope, which must NOT carry `e` (a contradictory
 * `s:"org"`+`e` envelope is rejected); any OTHER `s` value → null. So a truncated or old-shape envelope
 * (no `s`) resolves to the NARROWER endpoint scope and still needs an endpoint — it can never widen to org.
 * Only an explicit, signed `s:"org"` grants org scope.
 */
export async function verifyListenTicket(
  key: CryptoKey,
  token: string,
  nowSeconds: number,
): Promise<ListenTicketGrant | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  let bytes: Uint8Array;
  let presentedMac: Uint8Array;
  try {
    bytes = b64urlToBytes(token.slice(0, dot));
    presentedMac = b64urlToBytes(token.slice(dot + 1));
  } catch {
    return null;
  }
  const expectedMac = await tag(key, bytes);
  if (!timingSafeEqual(presentedMac, expectedMac)) return null;
  let env: ListenTicketEnvelope;
  try {
    env = JSON.parse(utf8Decoder.decode(bytes)) as ListenTicketEnvelope;
  } catch {
    return null;
  }
  // JSON.parse succeeds on the literals `null`/`true`/`123`/`"x"`; guard that `env` is a non-null object
  // before dereferencing `env.v` — otherwise `null.v` throws, breaking the never-throws (no-oracle) contract.
  if (typeof env !== "object" || env === null) return null;
  if (env.v !== LISTEN_TICKET_VERSION) return null;
  if (typeof env.exp !== "number" || nowSeconds > env.exp) return null;
  if (typeof env.o !== "string" || env.o === "") return null;
  // `u` is optional (deploy-compat within a version). If present it must be a non-empty string (a malformed
  // one is a bad ticket); if absent, the socket simply has no membership re-check and relies on the lifetime
  // cap.
  if (env.u !== undefined && (typeof env.u !== "string" || env.u === "")) return null;
  const userId = env.u ? { userId: env.u } : {};

  if (env.s === undefined || env.s === "endpoint") {
    // Endpoint scope (incl. an `s`-less v1/legacy ticket) REQUIRES a non-empty endpoint.
    if (typeof env.e !== "string" || env.e === "") return null;
    return { scope: "endpoint", orgId: env.o, endpointId: env.e, ...userId };
  }
  if (env.s === "org") {
    // Org scope must NOT carry an endpoint — a contradictory envelope fails closed.
    if (env.e !== undefined) return null;
    return { scope: "org", orgId: env.o, ...userId };
  }
  // Absent or unknown scope → null. Absence never grants.
  return null;
}
