import { createCredentialHasherFromBase64, credentialCacheKey } from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// A8c — per-request principal isolation, end-to-end through the REAL runtime (workerd + the WebhookMcp
// Durable Object). Two distinct api-key principals (different orgs). One initializes an MCP session and
// gets a principal-bound session id; the OTHER principal then presents that same session id with its own
// bearer. Without the binding it would route to the first principal's warm DO and read THEIR org; with it
// the request is rejected (404) before the transport can route. This is the cross-principal warm-DO test.

const ORIGIN = "https://mcp.webhook.co";
const TOKEN_A = "whk_isolation_principal_a"; // org_a
const TOKEN_B = "whk_isolation_principal_b"; // org_b

/** Seed the KV credential-cache hot path so `token` resolves to `orgId` (audience-bound) without Postgres. */
async function seedKey(token: string, orgId: string): Promise<void> {
  const pepper = await readSecretBinding(env.CREDENTIAL_PEPPER as SecretsStoreSecret | string);
  const hasher = createCredentialHasherFromBase64(pepper);
  const keyHash = hasher.candidates(token)[0];
  await (env.KV_AUTHZ as KVNamespace).put(
    credentialCacheKey(keyHash),
    JSON.stringify({ orgId, scopes: ["events:read"], audience: ORIGIN }),
  );
}

interface Rpc {
  status: number;
  sessionId: string | null;
}

/** POST one JSON-RPC message to /mcp with a given bearer + optional session id; read it fully. */
async function rpc(
  token: string,
  msg: Record<string, unknown>,
  sessionId?: string | null,
): Promise<Rpc> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  await res.text(); // drain so no SSE stream lingers
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") };
}

/** Initialize a session as `token` and return its (principal-bound) session id. */
async function initSession(token: string): Promise<string> {
  const init = await rpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "iso-test", version: "0.0.0" },
    },
  });
  expect(init.status).toBe(200);
  expect(init.sessionId, "initialize must return a bound mcp-session-id").toBeTruthy();
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  return init.sessionId as string;
}

describe("mcp session isolation — a session id is bound to its principal", () => {
  beforeEach(async () => {
    await seedKey(TOKEN_A, "org_a");
    await seedKey(TOKEN_B, "org_b");
  });

  it("the owning principal can keep using its session id", async () => {
    const sessionA = await initSession(TOKEN_A);
    const res = await rpc(
      TOKEN_A,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionA,
    );
    expect(res.status).toBe(200);
  });

  it("a DIFFERENT principal presenting the same session id is REJECTED (404), never reaching the DO", async () => {
    const sessionA = await initSession(TOKEN_A);
    // Principal B steals/reuses A's session id, but authenticates as itself.
    const res = await rpc(
      TOKEN_B,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionA,
    );
    expect(res.status).toBe(404); // bound to org_a; B's principal doesn't match → no DO access
  });

  it("the wrapped session id is opaque — it is not the raw transport id", async () => {
    const sessionA = await initSession(TOKEN_A);
    // The bound id is `<base64url(json)>.<base64url(mac)>` — it carries a dot-separated MAC, not a bare uuid.
    expect(sessionA).toContain(".");
  });
});
