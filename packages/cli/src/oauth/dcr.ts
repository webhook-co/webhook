import { z } from "zod";

import { OAuthError } from "../errors.js";
import type { OAuthFetch } from "./http.js";

// Dynamic Client Registration (RFC 7591). The CLI has no static client_id, so it registers a PUBLIC
// client (token_endpoint_auth_method "none") with its loopback redirect URIs, and caches the returned
// `client_id`. The issuer requires the redirect URIs to be http loopback IP LITERALS (127.0.0.1 / [::1],
// never `localhost`) — that's the caller's concern (the loopback server, D8c); this module just sends the
// request. Registration is JSON (RFC 7591), unlike the form-encoded token/device/revoke endpoints.

const RegisterResponseSchema = z.object({
  client_id: z.string().min(1),
});

export interface RegisterResult {
  readonly clientId: string;
}

/** The human-readable name the CLI registers under (RFC 7591 `client_name`), so the consent screen reads
 *  "Authorize webhook.co CLI" rather than the opaque generated `client_id`. */
export const CLI_CLIENT_NAME = "webhook.co CLI";

/**
 * Register a public client for the given loopback redirect URIs and return its `client_id`. The grant
 * types cover all three CLI flows (auth-code, refresh, device); S256 PKCE is enforced server-side.
 */
export async function registerClient(
  deps: OAuthFetch,
  registerUrl: string,
  redirectUris: readonly string[],
): Promise<RegisterResult> {
  const res = await deps.fetch(registerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLI_CLIENT_NAME,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      response_types: ["code"],
    }),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      /* non-JSON error body → keep the http_<status> code */
    }
    throw new OAuthError(code);
  }
  const parsed = RegisterResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new OAuthError("invalid_registration_response");
  return { clientId: parsed.data.client_id };
}
