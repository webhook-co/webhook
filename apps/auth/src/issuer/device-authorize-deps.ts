// A4b — wires the /device_authorization route's seams to the real provider (client lookup) + the device
// store. I/O glue (getOAuthApi + KV), so it's not unit-tested; it's typecheck-/build:cf-/deploy:dry-verified.
// Runs in the wrangler layer (getOAuthApi eagerly imports `cloudflare:workers`), imported only by
// issuer-handler/worker.ts, never by `next build`.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { API_RESOURCE, MCP_RESOURCE } from "@webhook-co/db";

import { makeDeviceStoreDeps } from "./device-deps";
import { createDeviceCode } from "./device-store";
import { CAPABILITY_SCOPES, oauthIssuerConfig } from "./oauth-config";
import type { DeviceAuthorizeDeps } from "./device-authorize-route";
import type { DeviceAuthorizeEnv } from "../runtime/env";

const DEVICE_CODE_TTL_SECONDS = 900; // 15 min — the user must enter + approve the code in this window.
const DEVICE_POLL_INTERVAL = 5;
const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };

/**
 * Build the /device_authorization deps for one request. `requestUrl` is the incoming URL — the verification
 * URI is derived from its (edge-set, trustworthy) origin so it's correct in dev + prod without a config.
 */
export function makeDeviceAuthorizeDeps(
  env: DeviceAuthorizeEnv,
  requestUrl: string,
): DeviceAuthorizeDeps {
  const helpers = getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  );
  const store = makeDeviceStoreDeps(env.DEVICE_KV);
  return {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    ttlSeconds: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL,
    verificationUri: new URL("/device", requestUrl).toString(),
    clientExists: async (clientId) => (await helpers.lookupClient(clientId)) !== null,
    createDeviceCode: (input) => createDeviceCode(store, input),
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };
}
