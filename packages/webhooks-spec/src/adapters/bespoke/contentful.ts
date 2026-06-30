// Contentful — a hand-written adapter because its signature is over a CANONICAL REQUEST whose header
// section is DYNAMIC: `x-contentful-signed-headers` lists which headers are folded into the signed
// string, so the message shape varies per request (no static config can express it). Reproduces
// @contentful/node-apps-toolkit `signRequest`/`verifyRequest` (verbatim-confirmed):
//
//   canonical = METHOD "\n" NORMALIZED_PATH "\n" HEADERS_SECTION "\n" RAW_BODY
//   HEADERS_SECTION = each signed header `key:value` (key lowercased+trimmed, value trimmed),
//                     sorted ascending by key, joined by ";"  (NB: the signed-headers HEADER uses ",")
//   NORMALIZED_PATH = getNormalizedEncodedURI(pathname + "?" + rawQuery)  (query order is significant)
//   sig = lowercase-hex HMAC-SHA256(secret_utf8, canonical);  secret is a 64-char string used verbatim.
//   TTL: reject if now - x-contentful-timestamp(ms) >= 30s (one-sided; replay is also bound IN the sig
//        because x-contentful-timestamp is itself one of the signed headers).

import { concatBytes, hexToBytes, hmacSha256, timingSafeEqual, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { findHeader } from "../shared";

const SIGNATURE_HEADER = "x-contentful-signature";
const TIMESTAMP_HEADER = "x-contentful-timestamp";
const SIGNED_HEADERS_HEADER = "x-contentful-signed-headers";
const TTL_SECONDS = 30;

/** Reproduce the toolkit's `getNormalizedEncodedURI`: escape the query, then encodeURI the whole. */
function normalizedEncodedUri(pathAndQuery: string): string {
  const q = pathAndQuery.indexOf("?");
  const pathname = q === -1 ? pathAndQuery : pathAndQuery.slice(0, q);
  // SDK splits on "?" and takes element [1] — i.e. the segment up to the next "?" (rare multi-? edge).
  const search = q === -1 ? undefined : pathAndQuery.slice(q + 1).split("?")[0];
  try {
    // querystring.escape ≈ encodeURIComponent over the RFC-3986 unreserved set (matches for query bytes).
    const target = search ? `${pathname}?${encodeURIComponent(search)}` : pathname;
    return encodeURI(target);
  } catch {
    return pathname; // encode* can throw on a lone surrogate — degrade, never throw into capture
  }
}

export function makeContentfulAdapter(): VerifyAdapter {
  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const malformed = (detail: string): VerificationResult =>
      verificationFailed({ code: "MALFORMED_SIGNATURE", detail, scheme: "contentful" });

    const signature = findHeader(input.headers, SIGNATURE_HEADER);
    if (signature === undefined) {
      return verificationFailed({
        code: "MISSING_HEADER",
        header: SIGNATURE_HEADER,
        scheme: "contentful",
      });
    }
    const expected = hexToBytes(signature.trim().toLowerCase());
    if (expected === null || expected.length !== 32)
      return malformed("signature is not 32-byte hex");

    const timestampRaw = findHeader(input.headers, TIMESTAMP_HEADER);
    const signedHeadersRaw = findHeader(input.headers, SIGNED_HEADERS_HEADER);
    if (timestampRaw === undefined || signedHeadersRaw === undefined) {
      return malformed(`missing ${TIMESTAMP_HEADER}/${SIGNED_HEADERS_HEADER}`);
    }

    // TTL (one-sided "too old"); timestamp is milliseconds. A non-numeric timestamp is MALFORMED.
    const timestampMs = Number(timestampRaw.trim());
    if (!Number.isInteger(timestampMs)) return malformed("non-integer timestamp");
    const nowMs = input.now?.getTime() ?? Date.now();
    const skewMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - timestampMs;
    if (skewMs >= TTL_SECONDS * 1000) {
      return verificationFailed({
        code: "TIMESTAMP_TOO_OLD",
        skewSeconds: Math.floor(skewMs / 1000),
        toleranceSeconds: TTL_SECONDS,
      });
    }

    if (input.requestUrl === undefined) return malformed("missing request url");
    let pathAndQuery: string;
    try {
      const url = new URL(input.requestUrl);
      pathAndQuery = url.pathname + url.search;
    } catch {
      return malformed("unparseable request url");
    }
    const path = normalizedEncodedUri(pathAndQuery);
    const method = input.method ?? "POST";

    // The DYNAMIC header section: exactly the headers named in x-contentful-signed-headers, each
    // `key:value` (key lowercased+trimmed, value trimmed), sorted ascending by key, joined by ";".
    const names = signedHeadersRaw
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n.length > 0);
    const pairs: [string, string][] = [];
    for (const name of names) {
      const value = findHeader(input.headers, name);
      if (value === undefined) return malformed(`missing signed header ${name}`);
      pairs.push([name, value.trim()]);
    }
    pairs.sort(([a], [b]) => (a > b ? 1 : -1));
    const headersSection = pairs.map(([k, v]) => `${k}:${v}`).join(";");

    // canonical = METHOD\nPATH\nHEADERS\nBODY. Build the prefix as UTF-8 and append the RAW body bytes
    // verbatim (byte-exact; no JSON re-serialization).
    const message = concatBytes(
      utf8Encoder.encode(`${method}\n${path}\n${headersSection}\n`),
      input.rawBody,
    );

    for (let i = 0; i < input.secrets.length; i++) {
      const secret = input.secrets[i]!;
      if (secret.length === 0) continue;
      const mac = await hmacSha256(utf8Encoder.encode(secret), message);
      if (timingSafeEqual(mac, expected)) return verificationOk(`secret_${i}`, "contentful");
    }
    return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
  }

  return {
    scheme: "contentful",
    signatureHeader: SIGNATURE_HEADER,
    toleranceSeconds: TTL_SECONDS,
    verify,
  };
}
