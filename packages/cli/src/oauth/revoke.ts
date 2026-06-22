import { postForm, type OAuthFetch } from "./http.js";

// RFC 7009 token revocation. The issuer returns 200 for ANY well-formed token (it never leaks whether the
// token existed) and discriminates `whk_` (access) vs `rtk_` (refresh) by prefix server-side; revoking the
// refresh handle cascades to the access key + evicts the authz cache. The CLI sends the refresh token on
// logout. Best-effort: the response status is not inspected (logout clears locally regardless); only a
// transport failure propagates (to the caller, which notes it and clears locally anyway).
export async function revokeToken(
  deps: OAuthFetch,
  revokeUrl: string,
  token: string,
): Promise<void> {
  await postForm(deps, revokeUrl, { token });
}
