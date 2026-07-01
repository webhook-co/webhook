// GET verification-handshake dispatcher (ADR-0086). When a GET to wbhk.my/<token> carries a known
// challenge protocol's params/headers, echo/compute the response the sender's subscription verification
// expects — so Meta/X/Dropbox/eBay/Adobe can complete setup against a wbhk.my URL. Mirrors the Slack
// url_verification handshake (ADR-0079): each responder is PURE + TOTAL (never throws), dispatched
// PRE-capture, and captures NOTHING (a control message, not an event).
//
// PR1 = the NO-SECRET protocols: Dropbox + Adobe I/O Events bare `?challenge=` echo, and Adobe Acrobat
// Sign's `X-AdobeSign-ClientId` header echo (the echoed value is the caller's own — no secret).
// PR2a added X/Twitter CRC: a `crc_token` GET is answered by HMAC-ing the token under the endpoint's
// registered `x` consumer secret, unsealed via an injected pre-capture `unseal` (the engine remains the
// sole unsealer). PR2b (this change) adds Meta (FB/IG/WhatsApp/Messenger): a `hub.mode=subscribe` GET
// echoes `hub.challenge` IFF the presented `hub.verify_token` matches a configured verify-token (sealed as
// a typed blob, constant-time compared), else 403. PR3 added eBay (`challenge_code` GET →
// `{"challengeResponse": hex(SHA256(challengeCode + verifyToken + endpointURL))}`). A POST dispatcher
// (`dispatchPostHandshake`) then landed the no-secret Graph/Twitch/monday echoes (S8 Slice 3) + Okta on the
// GET side, and now Zoom `endpoint.url_validation` (HMAC-SHA256 under the endpoint's `zoom` secret).

import { type CachedSealedSecret } from "@webhook-co/db";
import {
  bytesToB64,
  hexToBytes,
  importHmacKey,
  parseVerifyTokenSecret,
  utf8Decoder,
  utf8Encoder,
  verifyEd25519,
  verifyTokenEqual,
} from "@webhook-co/shared";

// Browser-safety headers shared by every (browser-reachable) handshake response: nosniff makes a
// reflected echo inert (required by Dropbox), and no-referrer + noindex keep the token-bearing URL out of
// referer logs + search indexes — uniform with the GET-liveness path (ingest.ts), since a handshake GET is
// equally pasteable into a browser.
const BROWSER_SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
} as const;

// A URL-safe token charset (alphanumeric + `._~+/=-`) covering UUID / hex / base64 / base64url tokens but
// EXCLUDING JSON structural bytes (`{ } " : , [ ]`) + whitespace. ANTI-FORGERY-ORACLE gate for X/Twitter CRC
// (S8 Slice 3): X's `x-twitter-webhooks-signature` signs the RAW BODY under the SAME consumer secret the CRC
// handshake HMACs, so an unrestricted `crc_token` lets an attacker get `HMAC(secret, <forged JSON body>)` and
// forge a `verified` event. A real `crc_token` is a plain token (the gold vector is a UUID); refusing a
// crc_token shaped like a JSON body means the handshake can't sign a realistic forged X event body.
const SAFE_HANDSHAKE_TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * X/Twitter Account Activity API CRC: respond with `{"response_token":"sha256="+base64(HMAC-SHA256(key,
 * crc_token))}` as `application/json`. The key is the app's **consumer secret** (NOT a bearer/access token);
 * base64 is **standard** (`+`/`/`); the `sha256=` prefix is literal. PURE: it takes the already-unsealed
 * consumer secret (the dispatcher resolves + unseals the endpoint's `x` provider secret). A wrong byte here
 * silently fails the subscription, so it is pinned to a gold vector.
 */
export async function xCrcResponse(crcToken: string, consumerSecret: string): Promise<Response> {
  const key = await importHmacKey(utf8Encoder.encode(consumerSecret));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(crcToken)));
  // Same browser-safety headers as the echoes: a CRC GET is equally pasteable into a browser, so keep the
  // token-bearing URL out of referers/indexes; nosniff makes the JSON inert. Response.json sets the JSON CT.
  return Response.json(
    { response_token: `sha256=${bytesToB64(sig)}` },
    { headers: BROWSER_SAFE_HEADERS },
  );
}

/** Echo a value as an inert `text/plain` 200 — the response shape every bare-challenge handshake wants. */
function plainTextEcho(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", ...BROWSER_SAFE_HEADERS },
  });
}

/**
 * Dropbox + Adobe I/O Events: a bare `?challenge=<v>` GET — echo `<v>` as `text/plain`. With nosniff the
 * echoed value is inert text regardless of content (Dropbox requires it). Absent/empty `challenge` is not a
 * handshake.
 */
function challengeEcho(url: URL): Response | null {
  const challenge = url.searchParams.get("challenge");
  if (challenge === null || challenge.length === 0) return null;
  return plainTextEcho(challenge);
}

/**
 * Meta (FB/IG/WhatsApp/Messenger) subscription verification: a `?hub.mode=subscribe&hub.challenge=<v>&
 * hub.verify_token=<t>` GET. Parse the three params; absent mode≠subscribe / empty challenge / empty
 * verify-token is not a (resolvable) handshake. The compare against the configured verify-token happens in
 * the dispatcher (it needs the unsealed secret).
 */
function metaHubChallenge(url: URL): { challenge: string; verifyToken: string } | null {
  if (url.searchParams.get("hub.mode") !== "subscribe") return null;
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = url.searchParams.get("hub.verify_token");
  if (challenge === null || challenge.length === 0) return null;
  if (verifyToken === null || verifyToken.length === 0) return null;
  return { challenge, verifyToken };
}

/**
 * eBay Marketplace Account Deletion/Closure endpoint validation: a `?challenge_code=<c>` GET. Respond with
 * `{"challengeResponse": hex(SHA256(challengeCode + verificationToken + endpoint))}` as `application/json`.
 * The concatenation ORDER is load-bearing (eBay recomputes + compares the exact hex), and `endpoint` is the
 * EXACT registered callback URL string (query-stripped, hashed verbatim — a trailing-slash/case mismatch
 * fails verification). PURE: takes the already-unsealed verify-token (the dispatcher resolves it).
 */
export async function ebayChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): Promise<Response> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      utf8Encoder.encode(challengeCode + verificationToken + endpoint),
    ),
  );
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Response.json({ challengeResponse: hex }, { headers: BROWSER_SAFE_HEADERS });
}

/**
 * Adobe Acrobat Sign: a GET carrying the `X-AdobeSign-ClientId` header — return 2xx and echo the SAME
 * client id back via the response header (one of Adobe's two accepted forms). No secret: the client id is
 * the caller's own value bounced 1:1, proving URL control, like the Slack/Dropbox nonce.
 */
function adobeSignEcho(headers: Headers): Response | null {
  const clientId = headers.get("x-adobesign-clientid");
  if (clientId === null || clientId.length === 0) return null;
  return new Response(null, {
    status: 200,
    headers: { "x-adobesign-clientid": clientId, ...BROWSER_SAFE_HEADERS },
  });
}

/**
 * Okta Event Hooks one-time verification: a GET carrying the `X-Okta-Verification-Challenge` header →
 * respond `{"verification":"<challenge>"}` as JSON. No secret — Okta's own value bounced back 1:1.
 */
function oktaVerification(headers: Headers): Response | null {
  const challenge = headers.get("x-okta-verification-challenge");
  if (challenge === null || challenge.length === 0) return null;
  return Response.json({ verification: challenge }, { headers: BROWSER_SAFE_HEADERS });
}

/** Parse a request body to a top-level JSON object, or `null` (not JSON / not an object / an array). */
function jsonBody(rawBody: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(rawBody));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Microsoft Graph change-notification URL validation: a POST with `?validationToken=<v>` (empty body) →
 * echo `<v>` (already URL-decoded by searchParams) as `text/plain`. No secret.
 */
function msGraphValidation(url: URL): Response | null {
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken === null || validationToken.length === 0) return null;
  return plainTextEcho(validationToken);
}

/**
 * Twitch EventSub `webhook_callback_verification`: a POST with header `Twitch-Eventsub-Message-Type:
 * webhook_callback_verification` and a JSON body `{challenge}` → echo the raw challenge as `text/plain`.
 * No secret (the activation is the echo; the request is separately HMAC-signed).
 */
function twitchVerification(headers: Headers, rawBody: Uint8Array): Response | null {
  if (headers.get("twitch-eventsub-message-type") !== "webhook_callback_verification") return null;
  const challenge = jsonBody(rawBody)?.challenge;
  if (typeof challenge !== "string" || challenge.length === 0) return null;
  return plainTextEcho(challenge);
}

/**
 * monday.com webhook verification: a POST whose body is EXACTLY `{"challenge":"<v>"}` → echo
 * `{"challenge":"<v>"}` as JSON. Detected precisely by the SINGLE `challenge` key (monday's verification
 * body carries nothing else), so a Slack `url_verification` (`{type, challenge}`), a Twitch verification
 * (`{challenge, subscription}`), or any real event never triggers it. No secret.
 */
function mondayChallenge(rawBody: Uint8Array): Response | null {
  const body = jsonBody(rawBody);
  if (body === null) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "challenge") return null;
  const challenge = body.challenge;
  if (typeof challenge !== "string" || challenge.length === 0) return null;
  return Response.json({ challenge }, { headers: BROWSER_SAFE_HEADERS });
}

/**
 * Asana webhook-creation handshake: the FIRST POST to a brand-new webhook carries a random
 * `X-Hook-Secret` header (and an empty/minimal body). Echo that header back verbatim on a 200 to activate
 * the webhook — otherwise Asana marks it failed and never delivers. No secret of our own: we bounce
 * Asana's own value 1:1 (like Adobe Sign / the Slack nonce). Detected purely by the header's presence; a
 * real Asana EVENT carries `X-Hook-Signature` (an HMAC over the body) — never `X-Hook-Secret` — so it is
 * never diverted and always captured. NOTE: this activates delivery (the wedge: receive/inspect/replay);
 * verifying Asana events needs that same `X-Hook-Secret` registered as the `asana` secret — surfacing it
 * (auto-capture / operator display) is a follow-up, since the echo is pre-capture.
 */
function asanaHookSecretEcho(headers: Headers): Response | null {
  const hookSecret = headers.get("x-hook-secret");
  if (hookSecret === null || hookSecret.length === 0) return null;
  return new Response(null, {
    status: 200,
    headers: { "x-hook-secret": hookSecret, ...BROWSER_SAFE_HEADERS },
  });
}

/**
 * Zoom webhook endpoint URL validation: a POST body `{"event":"endpoint.url_validation","payload":
 * {"plainToken":"<t>"}}` → `{"plainToken":"<t>","encryptedToken":hex(HMAC-SHA256(zoomSecret, plainToken))}`.
 * The key is the endpoint's registered `zoom` Secret Token — the SAME secret Zoom's POST `x-zm-signature`
 * verification uses (so no new storage). No `zoom` secret on the endpoint → not resolvable → `null`.
 */
async function zoomUrlValidation(
  rawBody: Uint8Array,
  sealedSecrets: readonly CachedSealedSecret[],
  unseal: (cached: CachedSealedSecret) => Promise<string>,
): Promise<Response | null> {
  const body = jsonBody(rawBody);
  if (body === null || body.event !== "endpoint.url_validation") return null;
  const payload = body.payload;
  const plainToken =
    typeof payload === "object" && payload !== null
      ? (payload as { plainToken?: unknown }).plainToken
      : undefined;
  if (typeof plainToken !== "string" || plainToken.length === 0) return null;
  // ANTI-FORGERY-ORACLE: this handshake HMACs an attacker-chosen `plainToken` under the SAME secret Zoom's
  // POST `x-zm-signature` verify uses, whose signed base string is `v0:{ts}:{body}`. Refuse to sign anything
  // shaped like that base string — a real Zoom plainToken is a colonless token, so rejecting a colon means
  // the handshake can never be coaxed into producing a valid x-zm-signature to forge a `verified` event.
  if (plainToken.includes(":")) return null;
  const zoomSecret = sealedSecrets.find((s) => s.provider === "zoom");
  if (zoomSecret === undefined) return null;
  const key = await importHmacKey(utf8Encoder.encode(await unseal(zoomSecret)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(plainToken)));
  const encryptedToken = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Response.json({ plainToken, encryptedToken }, { headers: BROWSER_SAFE_HEADERS });
}

/**
 * Discord subscription PING — Discord posts to ONE URL from TWO systems, both Ed25519-signed
 * (`X-Signature-Ed25519` hex over `timestamp + rawBody`, keyed by the app's hex public key). Only a PING is
 * a handshake, and the two systems collide on `type: 1`, so the discriminator MUST use the `event` field
 * (Discord docs): a **Webhook-Events PING** is `type: 0` → **204** empty; an **Interactions PING** is
 * `type: 1` with NO top-level `event` → `{"type":1}` **PONG** (200). A real **Webhook-Events Event** is
 * `type: 1` WITH an `event` object, and a real interaction is `type: 2-5` — BOTH fall through (`null`) to
 * normal capture (the discord adapter then verifies + marks them `verified`); never swallow a real event.
 * A missing/invalid signature on a PING → **401** (Discord's registration probes with a bad signature). NOT
 * an oracle: the responses are static and the handshake only VERIFIES the inbound signature (Discord's key).
 * No `discord` secret → `null` → capture.
 */
async function discordPing(
  headers: Headers,
  rawBody: Uint8Array,
  sealedSecrets: readonly CachedSealedSecret[],
  unseal: (cached: CachedSealedSecret) => Promise<string>,
): Promise<Response | null> {
  const body = jsonBody(rawBody);
  if (body === null) return null;
  const isWebhookPing = body.type === 0; // Application Webhook Events PING → 204
  const isInteractionsPing = body.type === 1 && !("event" in body); // Interactions PING → {type:1}
  if (!isWebhookPing && !isInteractionsPing) return null; // a real Event (type 1 + event) / interaction → capture
  const discordSecret = sealedSecrets.find((s) => s.provider === "discord");
  if (discordSecret === undefined) return null;
  const unauthorized = (): Response =>
    new Response("invalid request signature", { status: 401, headers: BROWSER_SAFE_HEADERS });
  const publicKey = hexToBytes(await unseal(discordSecret));
  const sigHex = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  const sig = sigHex !== null ? hexToBytes(sigHex) : null;
  if (publicKey === null || sig === null || timestamp === null) return unauthorized();
  // Discord signs `timestamp + rawBody` (no separator).
  const tsBytes = utf8Encoder.encode(timestamp);
  const message = new Uint8Array(tsBytes.length + rawBody.length);
  message.set(tsBytes, 0);
  message.set(rawBody, tsBytes.length);
  if (!(await verifyEd25519(publicKey, message, sig))) return unauthorized();
  return isWebhookPing
    ? new Response(null, { status: 204, headers: BROWSER_SAFE_HEADERS })
    : Response.json({ type: 1 }, { headers: BROWSER_SAFE_HEADERS });
}

/**
 * Route a POST to a subscription-validation handshake, or `null` if none matches. NO-SECRET echoes first
 * (Microsoft Graph `?validationToken`, Twitch `webhook_callback_verification`, monday.com `{challenge}`);
 * then the SECRET-based Zoom `endpoint.url_validation` (HMAC) and Discord `{type:1}` PING (Ed25519-verified
 * PONG), unsealed pre-capture like the GET dispatcher. Detection is by the request's own distinctive
 * param/header/body, dispatched PRE-capture, captures NOTHING. (Slack's `url_verification` stays dedicated.)
 */
export async function dispatchPostHandshake(
  url: URL,
  headers: Headers,
  rawBody: Uint8Array,
  sealedSecrets: readonly CachedSealedSecret[],
  unseal: (cached: CachedSealedSecret) => Promise<string>,
): Promise<Response | null> {
  const echo =
    msGraphValidation(url) ??
    twitchVerification(headers, rawBody) ??
    mondayChallenge(rawBody) ??
    asanaHookSecretEcho(headers);
  if (echo !== null) return echo;
  return (
    (await zoomUrlValidation(rawBody, sealedSecrets, unseal)) ??
    (await discordPing(headers, rawBody, sealedSecrets, unseal))
  );
}

/**
 * Route a GET to the matching verification-handshake responder, or `null` if it is not a recognized
 * (resolvable) handshake — the caller then falls through to the normal capture/liveness flow. Detection is
 * by the request's own distinctive params/headers and is mutually exclusive, so one protocol's request can
 * never trigger another's path. Secret-based protocols resolve the endpoint's sealed provider secret and
 * `unseal` it (the engine remains the sole unsealer); if the endpoint has no matching secret the request is
 * NOT a resolvable handshake → `null`. The no-secret echoes never touch `sealedSecrets`/`unseal`.
 */
export async function dispatchGetHandshake(
  url: URL,
  headers: Headers,
  sealedSecrets: readonly CachedSealedSecret[],
  unseal: (cached: CachedSealedSecret) => Promise<string>,
): Promise<Response | null> {
  // No-secret echoes first (Dropbox/Adobe `?challenge=`, Adobe Sign + Okta headers) — never touch secrets.
  const echo = adobeSignEcho(headers) ?? oktaVerification(headers) ?? challengeEcho(url);
  if (echo !== null) return echo;

  // X/Twitter CRC: `crc_token` → HMAC under the endpoint's registered `x` consumer secret (the SAME secret
  // used for X POST-signature verification). Gated by SAFE_HANDSHAKE_TOKEN so the handshake can't be used as
  // a signing oracle to forge a `verified` event (a crc_token shaped like a JSON body → not signed → falls
  // through to capture). No `x` secret on the endpoint → not resolvable → null.
  const crcToken = url.searchParams.get("crc_token");
  if (crcToken !== null && crcToken.length > 0 && SAFE_HANDSHAKE_TOKEN.test(crcToken)) {
    const xSecret = sealedSecrets.find((s) => s.provider === "x");
    if (xSecret !== undefined) {
      return xCrcResponse(crcToken, await unseal(xSecret));
    }
  }

  // Meta subscription verify: echo `hub.challenge` IFF the presented `hub.verify_token` equals a configured
  // verify-token (constant-time). The verify-token is sealed as a TYPED blob, so we unseal each `meta`
  // secret and skip the ones that aren't a verify-token (Meta's app-secret coexists under the same slug).
  // Configured-but-no-match → 403 (Meta's expected failure); none configured → null → falls through to
  // capture (no oracle beyond what an unknown token already exposes).
  const meta = metaHubChallenge(url);
  if (meta !== null) {
    let configured = false;
    for (const secret of sealedSecrets) {
      if (secret.provider !== "meta") continue;
      const verifyToken = parseVerifyTokenSecret(await unseal(secret));
      if (verifyToken === null) continue; // a signing secret, not a verify-token blob
      configured = true;
      if (verifyTokenEqual(meta.verifyToken, verifyToken)) return plainTextEcho(meta.challenge);
    }
    if (configured) {
      return new Response("forbidden", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", ...BROWSER_SAFE_HEADERS },
      });
    }
  }

  // eBay Marketplace Account Deletion: a `challenge_code` GET → SHA-256 of challengeCode + the configured
  // verify-token + the EXACT registered callback URL (query-stripped). Like Meta, the verify-token is a
  // typed blob coexisting with eBay's app-creds secret under the `ebay` slug, so skip non-verify-token
  // secrets. No ebay verify-token configured → not resolvable → null → falls through to capture.
  const challengeCode = url.searchParams.get("challenge_code");
  if (challengeCode !== null && challengeCode.length > 0) {
    for (const secret of sealedSecrets) {
      if (secret.provider !== "ebay") continue;
      const verifyToken = parseVerifyTokenSecret(await unseal(secret));
      if (verifyToken === null) continue; // an app-creds blob, not a verify-token
      return ebayChallengeResponse(challengeCode, verifyToken, `${url.origin}${url.pathname}`);
    }
  }

  return null;
}
