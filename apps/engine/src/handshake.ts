// GET verification-handshake dispatcher (ADR-0086). When a GET to wbhk.my/<token> carries a known
// challenge protocol's params/headers, echo/compute the response the sender's subscription verification
// expects — so Meta/X/Dropbox/eBay/Adobe can complete setup against a wbhk.my URL. Mirrors the Slack
// url_verification handshake (ADR-0079): each responder is PURE + TOTAL (never throws), dispatched
// PRE-capture, and captures NOTHING (a control message, not an event).
//
// PR1 (this file) = the NO-SECRET protocols: Dropbox + Adobe I/O Events bare `?challenge=` echo, and
// Adobe Acrobat Sign's `X-AdobeSign-ClientId` header echo. The secret-based protocols (Meta verify-token
// compare, X CRC HMAC, eBay hash) land in PR2/PR3 and extend dispatchGetHandshake with the unsealed
// per-endpoint secret.

// Browser-safety headers shared by every (browser-reachable) handshake response: nosniff makes a
// reflected echo inert (required by Dropbox), and no-referrer + noindex keep the token-bearing URL out of
// referer logs + search indexes — uniform with the GET-liveness path (ingest.ts), since a handshake GET is
// equally pasteable into a browser.
const BROWSER_SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
} as const;

/**
 * Dropbox + Adobe I/O Events: a bare `?challenge=<v>` GET — echo `<v>` as `text/plain`. With nosniff the
 * echoed value is inert text regardless of content (Dropbox requires it). Absent/empty `challenge` is not a
 * handshake.
 */
function challengeEcho(url: URL): Response | null {
  const challenge = url.searchParams.get("challenge");
  if (challenge === null || challenge.length === 0) return null;
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", ...BROWSER_SAFE_HEADERS },
  });
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
 * Route a GET to the matching verification-handshake responder, or `null` if it is not a recognized
 * handshake (the caller then falls through to the normal capture/liveness flow). Detection is by the
 * request's own distinctive params/headers and is mutually exclusive, so one protocol's request can never
 * trigger another's path (`hub.challenge` / `crc_token` / `challenge_code` are distinct param names from
 * the bare `challenge`, so they are NOT echoed here — they need a per-endpoint secret, added in PR2/PR3).
 * PURE + TOTAL — never throws, so the no-drop capture floor is never at risk.
 */
export function dispatchGetHandshake(url: URL, headers: Headers): Response | null {
  return adobeSignEcho(headers) ?? challengeEcho(url);
}
