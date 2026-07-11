// RFC 9207 §2.3 — advertise `authorization_response_iss_parameter_supported` on the AS metadata document.
//
// The provider (@cloudflare/workers-oauth-provider) generates /.well-known/oauth-authorization-server itself
// and has no RFC 9207 support and no hook to extend the document, so we augment its response on the way out
// (worker.ts, after provider.fetch). We DO emit `iss` on every authorization response (see iss-param.ts), and
// RFC 9207 says an AS that does so MUST advertise it — a client that sees the flag but no `iss` is required
// to REJECT the response, so shipping the parameter without the flag (or the flag without the parameter)
// breaks the very clients it's meant to protect. They ship together or not at all.
//
// Deliberately NOT added: any OIDC field. We are a pure OAuth 2.1 AS with opaque tokens — see ADR-0110.

/** The AS-metadata path the provider owns. Exact match: the provider itself does no path-suffix matching. */
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * Merge our RFC 9207 advertisement into the provider's AS-metadata JSON. Pure: takes the parsed document,
 * returns the augmented one. An unexpected shape (not a JSON object) is returned untouched — we never want a
 * metadata-augmentation bug to take discovery down.
 */
export function augmentAsMetadata(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  return {
    ...(doc as Record<string, unknown>),
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * If `response` is the provider's AS-metadata document, return a copy with our RFC 9207 advertisement merged
 * in; otherwise return it unchanged. Non-200s and unparseable bodies pass through untouched (never convert a
 * provider error into a different one). Headers are preserved, so the provider's CORS survives.
 */
export async function augmentAsMetadataResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status !== 200) return response;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return response;
  }
  if (pathname !== AS_METADATA_PATH) return response;

  let doc: unknown;
  try {
    doc = await response.clone().json();
  } catch {
    return response; // not JSON → leave the provider's response exactly as-is
  }
  return new Response(JSON.stringify(augmentAsMetadata(doc)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers, // keep the provider's content-type + CORS
  });
}
