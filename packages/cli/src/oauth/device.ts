import { z } from "zod";

import { OAuthError } from "../errors.js";
import { postForm, readOAuthError, type OAuthFetch } from "./http.js";
import { FrozenTokenBodySchema, type FrozenTokenBody } from "./token-client.js";

// The RFC 8628 device-authorization flow: request a device + user code, then poll `/token` with the
// device-code grant until the user approves in a browser. Over the injected fetch (fake-fetch tested).

export const DeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema>;

/** Start a device flow: POST `/device_authorization` → the device + user codes the user enters in a browser. */
export async function requestDeviceAuthorization(
  deps: OAuthFetch,
  deviceAuthUrl: string,
  opts: { clientId: string; scope: string; resource: string },
): Promise<DeviceAuthorization> {
  const res = await postForm(deps, deviceAuthUrl, {
    client_id: opts.clientId,
    scope: opts.scope,
    resource: opts.resource,
  });
  if (!res.ok) {
    const { code, detail } = await readOAuthError(res);
    throw new OAuthError(code, detail);
  }
  const parsed = DeviceAuthorizationSchema.safeParse(await res.json());
  if (!parsed.success) throw new OAuthError("invalid_device_authorization_response");
  return parsed.data;
}

/** One poll's outcome. `pending`/`slow_down` mean keep polling; `denied`/`expired` are terminal. */
export type DevicePoll =
  | { readonly kind: "token"; readonly body: FrozenTokenBody }
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

/**
 * Poll `/token` once with the device-code grant. The expected RFC 8628 §3.5 polling states
 * (authorization_pending / slow_down / access_denied / expired_token) are returned as variants for the
 * caller's loop; any other error is a hard OAuthError.
 */
export async function pollDeviceToken(
  deps: OAuthFetch,
  tokenUrl: string,
  opts: { deviceCode: string; clientId: string },
): Promise<DevicePoll> {
  const res = await postForm(deps, tokenUrl, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: opts.deviceCode,
    client_id: opts.clientId,
  });
  if (res.ok) {
    const parsed = FrozenTokenBodySchema.safeParse(await res.json());
    if (!parsed.success) throw new OAuthError("invalid_token_response");
    return { kind: "token", body: parsed.data };
  }
  const { code } = await readOAuthError(res);
  switch (code) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      throw new OAuthError(code);
  }
}
