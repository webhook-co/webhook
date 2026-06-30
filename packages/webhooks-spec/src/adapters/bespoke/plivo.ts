// Plivo V3 — a hand-written adapter: its signed string is a STATEFUL, conditionally-glued mix of the
// URL, the sorted query, and (for POST) the sorted form body, which no declarative config expresses.
// Reproduces plivo-python `signature_v3.py` + plivo-node `v3Security.js` (structurally identical):
//
//   message = base_url + "." + nonce        (nonce = X-Plivo-Signature-V3-Nonce)
//   base_url = scheme://host[:port]/path     (fragment dropped, port + trailing slash preserved)
//     + query/body, URL-DECODED then re-rendered:
//       query Q = params sorted by key, `key=value` joined by "&"
//       body  B = POST form fields sorted by key, `key`+`value` (NO "="), joined by "" (empty)
//     glue: prepend "?"+Q iff (Q present OR post-params present); insert "." iff (Q present AND post);
//           then append B.  → 4 POST cases: `…?Q.B` · `…?Q` · `…?B` (bare ?) · `…`
//   sig = standard-base64 HMAC-SHA256(authToken_utf8, message); the header value may be a comma-list of
//   sigs (match ANY). Both X-Plivo-Signature-V3 (account token) and X-Plivo-Signature-Ma-V3 (main-account
//   token) sign the SAME base string + nonce — only the key differs, so we collect both and match-any
//   against the registered token. No replay window.

import { b64ToBytes, hmacSha256, timingSafeEqual, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { findHeader } from "../shared";

const SIGNATURE_HEADER = "x-plivo-signature-v3";
const MAIN_ACCOUNT_HEADER = "x-plivo-signature-ma-v3";
const NONCE_HEADER = "x-plivo-signature-v3-nonce";

/** params sorted ascending by key (byte order, matching Python `sorted`). */
function sortedEntries(params: URLSearchParams): [string, string][] {
  return [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Build Plivo's `base_url` — null if the request URL is absent/unparseable (→ MALFORMED, never throw). */
function plivoBaseUrl(input: VerifyInput): string | null {
  if (input.requestUrl === undefined) return null;
  let url: URL;
  try {
    url = new URL(input.requestUrl);
  } catch {
    return null;
  }
  const base = `${url.protocol}//${url.host}${url.pathname}`; // scheme://host[:port]/path, no fragment
  const query = sortedEntries(url.searchParams)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  if ((input.method ?? "POST").toUpperCase() !== "POST") {
    return query.length > 0 ? `${base}?${query}` : base; // GET (or other): URL + sorted query only
  }
  // POST: append the sorted body, with the conditional `?` / `.` glue.
  const bodyEntries = sortedEntries(new URLSearchParams(utf8Decoder.decode(input.rawBody)));
  const body = bodyEntries.map(([k, v]) => `${k}${v}`).join("");
  const postPresent = bodyEntries.length > 0;
  let result = base;
  if (query.length > 0 || postPresent) result += `?${query}`;
  if (query.length > 0 && postPresent) result += ".";
  return result + body;
}

export function makePlivoAdapter(): VerifyAdapter {
  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const nonce = findHeader(input.headers, NONCE_HEADER);
    if (nonce === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: NONCE_HEADER, scheme: "plivo" });
    }
    // Collect signatures from BOTH headers (each a comma-list); match-any — our token only reproduces
    // its own pair (sub-account → -V3, or main-account → -Ma-V3).
    const sigStrings: string[] = [];
    for (const header of [SIGNATURE_HEADER, MAIN_ACCOUNT_HEADER]) {
      const value = findHeader(input.headers, header);
      if (value !== undefined) {
        for (const part of value.split(",")) {
          const trimmed = part.trim();
          if (trimmed.length > 0) sigStrings.push(trimmed);
        }
      }
    }
    if (sigStrings.length === 0) {
      return verificationFailed({
        code: "MISSING_HEADER",
        header: SIGNATURE_HEADER,
        scheme: "plivo",
      });
    }

    const base = plivoBaseUrl(input);
    if (base === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "missing or unparseable request url",
        scheme: "plivo",
      });
    }
    const message = utf8Encoder.encode(`${base}.${nonce}`);

    // Decode the base64 signatures to 32-byte MACs; a non-32-byte decode can't match a SHA-256 MAC.
    const expected = sigStrings
      .map((s) => b64ToBytes(s))
      .filter((b): b is Uint8Array => b !== null && b.length === 32);
    if (expected.length === 0) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not 32-byte base64",
        scheme: "plivo",
      });
    }

    for (let i = 0; i < input.secrets.length; i++) {
      const secret = input.secrets[i]!;
      if (secret.length === 0) continue;
      const mac = await hmacSha256(utf8Encoder.encode(secret), message);
      if (expected.some((e) => timingSafeEqual(mac, e)))
        return verificationOk(`secret_${i}`, "plivo");
    }
    return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
  }

  return { scheme: "plivo", signatureHeader: SIGNATURE_HEADER, toleranceSeconds: 300, verify };
}
