// A4c-3 — wires /device/verify's seams to the real session + rate limiter + device store + consent core.
// I/O glue (getOAuthApi + makeAuth + KV + a DB pool), so it's not unit-tested; it's typecheck-/build:cf-/
// deploy:dry-verified. Runs in the wrangler layer (getOAuthApi imports `cloudflare:workers`), imported only
// by issuer-handler/worker.ts, never by `next build`.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { API_RESOURCE, MCP_RESOURCE, createClient, getConsentOrg } from "@webhook-co/db";
import { b64ToBytes, readSecretBinding } from "@webhook-co/shared";

import { buildDeviceConsent } from "./consent-core";
import { importConsentTicketKey, signConsentTicket } from "./consent-ticket";
import { makeDeviceStoreDeps } from "./device-deps";
import { findByUserCode } from "./device-store";
import type { DeviceVerifyRouteDeps } from "./device-verify-route";
import { CAPABILITY_SCOPES, oauthIssuerConfig } from "./oauth-config";
import { consumeRateLimit } from "./rate-limit";
import { makeAuth, type AuthExecutionContext, type RuntimeAuth } from "../runtime/auth";
import type { DeviceVerifyEnv } from "../runtime/env";
import { LOGIN_PATH } from "../runtime/urls";

const KEY_TTL_SECONDS = 86_400;
const GRANT_TTL_SECONDS = 7_776_000;
const TICKET_TTL_SECONDS = 300;
const CONSENT_PATH = "/consent";
// The guess-rate budget for the ~40-bit user-code, keyed per session principal: low count + short window
// (ADR-0032 — fixed-window admits ≤2× across a seam, so the effective ceiling is well inside the budget).
const VERIFY_RATE_RULE = { limit: 10, windowSeconds: 300 };

const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };
const nowSeconds = () => Math.floor(Date.now() / 1000);

function resolveOrigin(request: Request): { ip: string; location: string | null } {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const country = request.headers.get("cf-ipcountry");
  const location = country && !["XX", "T1"].includes(country) ? country : null;
  return { ip, location };
}

export interface DeviceVerifyDeps {
  deps: DeviceVerifyRouteDeps;
  close: () => Promise<void>;
}

/** Build the /device/verify deps for one request. */
export async function makeDeviceVerifyDeps(
  env: DeviceVerifyEnv,
  ctx?: AuthExecutionContext,
): Promise<DeviceVerifyDeps> {
  const ticketKey = await importConsentTicketKey(
    b64ToBytes(await readSecretBinding(env.CONSENT_TICKET_KEY)),
  );
  const helpers = getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  );
  const deviceStore = makeDeviceStoreDeps(env.DEVICE_KV);

  // The session runtime + tenant pool are the expensive parts — build lazily so a rate-limited / bad-code
  // request (the common abuse path) pays for neither beyond the session check.
  let auth: RuntimeAuth | undefined;
  const getAuth = async () => (auth ??= await makeAuth(env, ctx));
  let app: ReturnType<typeof createClient> | undefined;
  const getApp = () => (app ??= createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 2 }));

  const log = (event: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message: event, ...fields }));

  const deps: DeviceVerifyRouteDeps = {
    getSessionUserId: async (request) =>
      (await (await getAuth()).getSession(request))?.userId ?? null,
    resolveOrigin,
    rateLimitBucket: (userId) => `device-verify:user:${userId}`,
    rateLimit: (bucket) =>
      consumeRateLimit({ kv: env.RATELIMIT_KV as never, nowSeconds }, bucket, VERIFY_RATE_RULE),
    loginUrl: (returnTo) => `${LOGIN_PATH}?redirect=${encodeURIComponent(returnTo)}`,
    findDeviceRecord: async (userCode) => {
      const rec = await findByUserCode(deviceStore, userCode);
      // Only a still-pending code can be approved; treat decided/expired as not-found (anti-enumeration).
      if (!rec || rec.status !== "pending") return null;
      return {
        userCode: rec.userCode,
        clientId: rec.clientId,
        scopes: rec.scopes,
        audience: rec.audience,
      };
    },
    buildDeviceConsent: (record, userId, origin) =>
      buildDeviceConsent(
        {
          allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
          allowedScopes: CAPABILITY_SCOPES,
          keyTtlSeconds: KEY_TTL_SECONDS,
          grantTtlSeconds: GRANT_TTL_SECONDS,
          ticketTtlSeconds: TICKET_TTL_SECONDS,
          consentPath: CONSENT_PATH,
          lookupClientName: async (clientId) =>
            (await helpers.lookupClient(clientId))?.clientName ?? null,
          getConsentOrg: (uid) => getConsentOrg(getApp(), uid),
          signTicket: (payload) => signConsentTicket(payload, ticketKey),
          newCsrf: () => crypto.randomUUID(),
          nowSeconds,
          log,
        },
        record,
        userId,
        origin,
      ),
  };

  return {
    deps,
    close: async () => {
      await Promise.allSettled([app?.end(), auth?.close()].filter(Boolean) as Promise<unknown>[]);
    },
  };
}
