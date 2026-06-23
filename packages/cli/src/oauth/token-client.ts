import { z } from "zod";

import type { OAuthCredential } from "../config/schema.js";
import { OAuthError } from "../errors.js";
import { postForm, readOAuthError, type OAuthFetch } from "./http.js";

// The Lane C `/token` client: the authorization-code exchange + the refresh-token rotation. Both return
// the FrozenTokenBody (the `whk_` access key + the rotating `rtk_` refresh handle + metadata), which
// `toOAuthCredential` turns into the stored OAuth credential (synthesizing the CLI-side fields the wire
// doesn't return: expiresAt, audience, authMethod, clientId). `fetch` is injected → fake-fetch tested.

/** The exact `/token` success body (every field always present). Audience/scope are server-bound. */
export const FrozenTokenBodySchema = z.object({
  access_token: z.string().min(1), // the whk_ key
  token_type: z.string(),
  expires_in: z.number().int().positive(), // a 0-second lifetime is malformed (matches device.ts)
  refresh_token: z.string().min(1), // the rtk_ handle (always rotated on refresh)
  scope: z.string(),
  resource: z.string(),
});
export type FrozenTokenBody = z.infer<typeof FrozenTokenBodySchema>;

async function tokenRequest(
  deps: OAuthFetch,
  tokenUrl: string,
  params: Record<string, string>,
): Promise<FrozenTokenBody> {
  const res = await postForm(deps, tokenUrl, params);
  if (!res.ok) {
    const { code, detail } = await readOAuthError(res);
    throw new OAuthError(code, detail);
  }
  const parsed = FrozenTokenBodySchema.safeParse(await res.json());
  if (!parsed.success) throw new OAuthError("invalid_token_response");
  return parsed.data;
}

/** Exchange an authorization code (+ PKCE verifier) for the FrozenTokenBody. */
export function exchangeAuthCode(
  deps: OAuthFetch,
  tokenUrl: string,
  opts: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    resource: string;
  },
): Promise<FrozenTokenBody> {
  return tokenRequest(deps, tokenUrl, {
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    resource: opts.resource,
  });
}

/**
 * Refresh: exchange the `rtk_` handle for a fresh FrozenTokenBody. The issuer ALWAYS rotates (the new
 * refresh_token replaces the old, which is invalidated), so the caller MUST persist the returned
 * credential — a crash between this 200 and the persist leaves the old handle dead → a forced re-login.
 */
export function refreshAccessToken(
  deps: OAuthFetch,
  tokenUrl: string,
  opts: { refreshToken: string; clientId: string; resource: string },
): Promise<FrozenTokenBody> {
  return tokenRequest(deps, tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    resource: opts.resource,
  });
}

/**
 * Turn a FrozenTokenBody into the stored OAuth credential, synthesizing the fields the wire doesn't
 * return: `expiresAt` (= mint time + expires_in), `audience` (= the server-bound resource), `authMethod`,
 * and `clientId` (the DCR registration). `now` is injected for determinism.
 */
export function toOAuthCredential(
  body: FrozenTokenBody,
  opts: { authMethod: "loopback" | "device"; clientId: string; now: number },
): OAuthCredential {
  return {
    oauth: {
      accessKey: body.access_token,
      refreshToken: body.refresh_token,
      authMethod: opts.authMethod,
      expiresAt: opts.now + body.expires_in * 1000,
      audience: body.resource,
      clientId: opts.clientId,
    },
  };
}
