import { createCredentialHasherFromBase64, credentialCacheKey } from "@webhook-co/db";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// End-to-end through the real runtime: an API-key bearer -> resolveExternalToken (KV hot path) ->
// the OAuth grant -> the WebhookMcp Durable Object -> the MCP transport. We drive the JSON-RPC
// handshake directly over SELF.fetch (each request reads its response to completion, so no SSE
// stream lingers) and assert tools/list surfaces the 5 read tools. This is the first time init()
// runs in workerd, so it also proves the zod-input -> MCP-tool-schema conversion. The tenant DB
// read itself is covered exhaustively in the db pool (packages/db reads.test.ts), so this test
// deliberately stops at tools/list (no Postgres): it proves the WIRING, not the reads.

const ORIGIN = "https://mcp.webhook.co";
const TOKEN = "whsk_test_integration_key";
const READ_TOOLS = ["audit.verify", "endpoints.get", "endpoints.list", "events.get", "events.list"];

/** Seed the KV credential-cache hot path so resolveExternalToken resolves TOKEN without Postgres. */
async function seedApiKey(scopes: readonly string[]): Promise<void> {
  const hasher = createCredentialHasherFromBase64(env.CREDENTIAL_PEPPER as string);
  const keyHash = hasher.candidates(TOKEN)[0];
  await (env.KV_AUTHZ as KVNamespace).put(
    credentialCacheKey(keyHash),
    JSON.stringify({ orgId: "org_test", scopes, audience: ORIGIN }),
  );
}

interface RpcResponse {
  readonly status: number;
  readonly sessionId: string | null;
  readonly message: { result?: unknown; error?: unknown; id?: unknown } | null;
}

/** Extract the first JSON-RPC message from a response body (handles both JSON and SSE framing). */
function parseRpcBody(contentType: string, body: string): RpcResponse["message"] {
  const text = body.trim();
  if (text === "") return null;
  if (contentType.includes("text/event-stream")) {
    // SSE frames: one or more `data: {json}` lines. Take the first data payload.
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice("data:".length).trim()) : null;
  }
  return JSON.parse(text);
}

/** POST a single JSON-RPC message to /mcp with the bearer + optional session, read it fully. */
async function rpc(
  msg: Record<string, unknown>,
  opts: { sessionId?: string | null; protocolVersion?: string } = {},
): Promise<RpcResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  if (opts.protocolVersion) headers["mcp-protocol-version"] = opts.protocolVersion;
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  const body = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    message: parseRpcBody(res.headers.get("content-type") ?? "", body),
  };
}

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Invoke a tool by name and return its CallToolResult (content + isError). */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  session: { sessionId: string; protocolVersion: string },
  id: number,
): Promise<ToolCallResult> {
  const res = await rpc(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  expect(res.status).toBe(200);
  return res.message?.result as ToolCallResult;
}

/** Run the MCP initialize handshake and return the session id + negotiated protocol version. */
async function handshake(): Promise<{ sessionId: string; protocolVersion: string }> {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "webhook-mcp-test", version: "0.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const sessionId = init.sessionId;
  expect(sessionId, "initialize must return an mcp-session-id").toBeTruthy();
  const result = init.message?.result as { protocolVersion?: string } | undefined;
  const protocolVersion = result?.protocolVersion ?? "2025-06-18";
  // Per the MCP lifecycle, the client confirms with an `initialized` notification.
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId, protocolVersion });
  return { sessionId: sessionId as string, protocolVersion };
}

describe("mcp tool surface — authenticated end-to-end", () => {
  beforeEach(async () => {
    await seedApiKey(["endpoints:read", "events:read", "audit:read"]);
  });

  it("lists exactly the 5 read tools after the initialize handshake", async () => {
    const { sessionId, protocolVersion } = await handshake();
    const res = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { sessionId, protocolVersion },
    );
    expect(res.status).toBe(200);
    const { tools } = res.message?.result as { tools: { name: string }[] };
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("advertises an input schema exposing the endpointId parameter for events.list", async () => {
    const { sessionId, protocolVersion } = await handshake();
    const res = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { sessionId, protocolVersion },
    );
    const { tools } = res.message?.result as { tools: { name: string; inputSchema?: unknown }[] };
    const eventsList = tools.find((t) => t.name === "events.list");
    expect(eventsList?.inputSchema).toBeDefined();
    expect(JSON.stringify(eventsList?.inputSchema)).toContain("endpointId");
  });

  it("denies a tools/call when the key lacks the capability's scope (FORBIDDEN, before any DB)", async () => {
    // Seed a key WITHOUT audit:read, then call audit.verify. The shared handler's scope check fails
    // closed before any tenant read, so this exercises the full grant -> dispatch -> CapabilityFault
    // -> isError wiring end-to-end with no Postgres.
    await seedApiKey(["endpoints:read", "events:read"]);
    const session = await handshake();
    const result = await callTool("audit.verify", {}, session, 4);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("FORBIDDEN");
  });
  // The operational-fault masking (a thrown handler error -> a generic, leak-free isError + a log,
  // never the raw message the MCP SDK would otherwise echo) is proven at the unit level in
  // src/tools.test.ts. We don't reproduce it here because forcing a tenant-read failure means a real
  // Postgres connection attempt against the absent test DB, whose teardown leaves stray stream
  // cancellations — env noise, not coverage the unit test lacks.
});

describe("mcp tool surface — unauthenticated", () => {
  it("rejects the MCP endpoint with 401 when no bearer is presented", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
