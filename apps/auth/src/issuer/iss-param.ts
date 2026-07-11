// RFC 9207 — the `iss` (issuer identifier) parameter on authorization responses.
//
// WHY: an MCP client talks to many authorization servers. In a mix-up attack, an attacker who controls one
// of them induces the client to send an authorization code issued by an HONEST server to the ATTACKER's
// token endpoint (or vice versa). PKCE does NOT prevent this — the client hands its code_verifier to the
// attacker's token endpoint itself. Resource indicators don't either. The defense is for the honest AS to
// stamp its own identity onto the authorization response, so the client can compare it against the issuer it
// recorded before it redirected, and refuse a response that came back from somewhere else.
//
// The MCP spec: authorization servers SHOULD include `iss` in authorization responses INCLUDING ERROR
// responses, and an AS that includes it MUST advertise `authorization_response_iss_parameter_supported:
// true` in its metadata (RFC 9207 §2.3). The two go together — see as-metadata.ts for the advertisement.
// The mitigation is worthless without the advertisement, and the advertisement is a lie without the
// parameter.

/**
 * Stamp `iss` onto an authorization response redirect. `location` must be the ABSOLUTE client redirect_uri
 * we are bouncing back to (success or error); a relative location — the device flow's own `/device?status=…`
 * page — is not an authorization response to a client and is returned unchanged.
 */
export function withIssParam(location: string, issuer: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative (device status page) → not an authorization response
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}
