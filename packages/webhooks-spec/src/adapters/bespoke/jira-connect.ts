// Jira / Atlassian Connect webhooks — `Authorization: JWT <token>` (literal scheme word `JWT`, not
// `Bearer`). An HS256 JWT signed with the install `sharedSecret` (VERBATIM utf8 — it looks base64 but is
// opaque, do NOT decode). The token binds the REQUEST (method + path + sorted query) via the `qsh`
// (query-string-hash) claim, NOT the body — so this is request/origin-authenticated, body not integrity-
// bound. `iss` is the tenant clientKey (varies per install), so we don't pin it; the HS256 MAC with the
// registered sharedSecret is the proof. A `qsh` literal `"context-qsh"` marks a context token (skip the
// request-hash compare).
//
// DISTINCT from the `atlassian_jira` config row, which covers Jira's mainstream `x-hub-signature` raw-body
// system webhooks. This Connect-app JWT path is a separate, niche integration.
//
// qsh = lowercase_hex(SHA256( UPPER(method) + "&" + canonicalPath + "&" + canonicalQuery )), where the
// canonical query RFC3986-encodes names+values, sorts by name, joins repeated values with a LITERAL comma
// (the Jira doc prose saying `%2C` is WRONG — atlassian-jwt + the worked examples use `,`), and drops a
// `jwt` param. Validated against Atlassian's published Bitbucket + Jira gold vectors (jira-connect.test).

import { bytesToHex, sha256, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { enforceJwtWindow, jwsFailureToResult, verifyCompactHs } from "../jws";
import { findHeader } from "../shared";

const HEADER = "authorization";
const JWT_SCHEME = "jwt "; // the literal `JWT ` scheme word (matched case-insensitively)

/** RFC3986 percent-encoding: encode everything except the unreserved set `A-Za-z0-9-_.~`. */
function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Atlassian's canonical query string: drop a `jwt` param, sort names, and for a repeated name SORT ITS RAW
 * VALUES then RFC3986-encode each and join with a LITERAL comma — atlassian-jwt sorts raw-then-encodes, and
 * percent-encoding is not order-preserving, so encode-then-sort would diverge for some repeated values.
 * Names sorted raw too. Pairs joined by `&`.
 */
function canonicalQuery(params: URLSearchParams): string {
  const names = [...new Set(params.keys())].filter((n) => n !== "jwt").sort();
  return names
    .map((name) => {
      const values = params.getAll(name).sort().map(rfc3986Encode);
      return `${rfc3986Encode(name)}=${values.join(",")}`;
    })
    .join("&");
}

/**
 * Build Atlassian's canonical request string `METHOD&path&canonicalQuery`. Returns null if the URL is
 * unparseable. Exported so tests can assert it against Atlassian's PUBLISHED canonical-string example
 * (the strongest check of the encoding/sort/comma-join rules, independent of the hash).
 */
export function jiraCanonicalRequest(method: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  // Path is relative (origin stripped via pathname); a literal `&` is %-encoded so it can't be read as the
  // section separator; an empty path canonicalizes to "/".
  const path = (url.pathname || "/").replace(/&/g, "%26");
  return `${method.toUpperCase()}&${path}&${canonicalQuery(url.searchParams)}`;
}

/**
 * Compute the Atlassian Connect `qsh` = lowercase-hex SHA-256 of the canonical request. Returns null if the
 * URL is unparseable (→ a typed MALFORMED at the call site, never a throw).
 */
export async function jiraQsh(method: string, requestUrl: string): Promise<string | null> {
  const canonical = jiraCanonicalRequest(method, requestUrl);
  if (canonical === null) return null;
  return bytesToHex(await sha256(utf8Encoder.encode(canonical)));
}

export function makeJiraConnectAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.jira_connect;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    let value = findHeader(input.headers, HEADER);
    if (value === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: "jira_connect" });
    }
    if (value.toLowerCase().startsWith(JWT_SCHEME)) value = value.slice(JWT_SCHEME.length).trim();

    const jws = await verifyCompactHs(value, input.secrets);
    if (!jws.ok) return jwsFailureToResult(jws.reason, "jira_connect");
    const { payload, secretIndex } = jws;

    // Freshness — Connect tokens carry a short exp (~3 min); iss is the per-install clientKey (not pinned).
    const stale = enforceJwtWindow(payload, toleranceSeconds, input.now);
    if (stale !== null) return stale;

    // Request binding via qsh — REQUIRED. The qsh must equal the recomputed hash of THIS request (method +
    // path + sorted query). We deliberately do NOT honor a literal `context-qsh` here: that value marks
    // browser-exposed FRONTEND context tokens (iframe / AP.context.getToken), never a webhook delivery —
    // honoring it would broaden "verified Jira" to those more-exposed tokens with an unbound body. An
    // absent qsh leaves the request unbound → reject. (qsh covers the request line, not the body.)
    const qsh = payload.qsh;
    if (typeof qsh !== "string") {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }
    if (input.requestUrl === undefined) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "missing request url for qsh",
        scheme: "jira_connect",
      });
    }
    const computed = await jiraQsh(input.method ?? "POST", input.requestUrl);
    if (computed === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "unparseable request url",
        scheme: "jira_connect",
      });
    }
    if (computed !== qsh.toLowerCase()) {
      return verificationFailed({ code: "SIGNATURE_MISMATCH" });
    }

    return verificationOk(`secret_${secretIndex}`, "jira_connect");
  }

  return { scheme: "jira_connect", signatureHeader: HEADER, toleranceSeconds, verify };
}
