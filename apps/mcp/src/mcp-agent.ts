import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AnyCapability, AuthContext } from "@webhook-co/contract";
import {
  buildCapabilityHandlers,
  createClient,
  createCredentialHasherFromBase64,
  makeIngestHashEvictor,
  type CredentialHasher,
} from "@webhook-co/db";
import { b64ToBytes, importAuditKey, importCursorKey, readSecretBinding } from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";
import type { z } from "zod";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";
import { grantPropsToAuthContext } from "./grant";
import { genericToolError, runCapabilityTool, type McpToolResult } from "./tools";
import type { McpEnv } from "./env";

// The webhook.co MCP server as a Cloudflare Agent (Durable Object). It registers the read
// capabilities (MCP_BOUND_CAPABILITIES) as MCP tools, each binding the SHARED createReadHandlers
// map — the very same handlers apps/api dispatches over HTTP, so the two surfaces can't drift.
//
// Auth: the resource-server router (resource-handler.ts, A8) validates the bearer (a `whk_` api key via
// the credential chain, or an opaque OAuth token via introspection to auth.) and sets the resolved
// principal on the execution context, which the McpAgent surfaces as `this.props`; grantPropsToAuthContext
// re-validates that shape into an AuthContext at the trust boundary (grant.ts). Each tool then runs
// the shared handler under RLS with a per-call tenant client. NO fault is ever thrown out of a tool
// handler — the MCP SDK would echo the message to the client — so a malformed principal or an
// operational fault is logged and returned as a generic, leak-free error (see tools.ts). The
// cursor/audit HMAC keys are imported once per DO start (init).
//
// SESSION BINDING (security): the McpAgent Durable Object is keyed by the `Mcp-Session-Id`, and
// `this.props` is set ONCE — from the principal of the request that INITIALIZES the session (McpAgent
// `onStart`; warm requests don't refresh it). So a warm DO is pinned to its initializing principal. A8c
// closes cross-principal reuse at the resource-server EDGE (not in the DO): the session id handed to the
// client is an HMAC-signed envelope BOUND to that principal (resource-handler.ts + session-binding.ts), and
// every request must present a session id that unbinds to the SAME principal or it's rejected (404) before
// the transport routes the DO. So a reused/stolen session id can't reach another principal's DO — by the
// time a request reaches this tool handler, its principal already matches `this.props`. (Edge wrapping, not
// in-DO routing, because the streamable-HTTP handler routes purely by session id and surfaces no per-request
// principal to the DO. Was the ADR-0011 follow-up; see ADR-0035.)

const SERVER_NAME = "webhook.co";
const SERVER_VERSION = "0.0.0";

/** Concise, agent-facing descriptions for the bound read tools (MCP tool discovery). */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "endpoints.list":
    "List the org's webhook endpoints (paginated). Optional `filter.name` does a case-insensitive substring match on the endpoint name.",
  "endpoints.get": "Get a single webhook endpoint by id.",
  "endpoints.create":
    "Create a webhook endpoint and return its ingest URL. The URL contains a secret token shown ONLY ONCE in this response — surface it to the user to save; it cannot be retrieved again.",
  "endpoints.delete":
    "DESTRUCTIVE: permanently soft-delete a webhook endpoint by id. Its ingest URL stops accepting new events and it is removed from listings; captured events are retained but the endpoint can no longer receive new ones. Confirm with the user before calling.",
  "endpoints.rotate":
    "DESTRUCTIVE: rotate a webhook endpoint's ingest URL by id — mints a NEW URL and revokes the old one (for a leaked or lost URL). The endpoint id, name, and captured events are kept. The new URL contains a secret token shown ONLY ONCE in this response — surface it to the user to save. Confirm with the user before calling.",
  "events.list":
    "List received events for an endpoint (paginated, newest-first). Optional filters (AND together): `filter.provider`; and a received-at range `filter.receivedAfter` (inclusive) / `filter.receivedBefore` (exclusive), each an RFC 3339 timestamp.",
  "events.get": "Get a received event by id — headers, verification result, and payload pointer.",
  "events.tail":
    "Tail an endpoint's events forward, oldest-first, up to the safety watermark. Start from `since` (now | beginning | a duration like 30m/2h | an RFC 3339 timestamp) or resume from a prior cursor; pass the returned nextCursor back to continue. The response also reports headCursor + caughtUp so you can tell when you've reached the head.",
  "audit.verify": "Verify the org's tamper-evident audit chain; reports the first break, if any.",
  "endpoints.addProviderSecret":
    "Register an inbound-verification signing secret on an endpoint so received webhooks from that provider are cryptographically verified. Provide `provider` (stripe|github|shopify|slack|standard_webhooks) and the plaintext `secret`; it is sealed server-side and NEVER returned. Treat the secret as sensitive — confirm with the user before storing one on their behalf.",
  "endpoints.listProviderSecrets":
    "List an endpoint's provider signing secrets as metadata (id, provider, status, label, created) — never the secret values.",
  "endpoints.revokeProviderSecret":
    "Revoke a provider signing secret by id on an endpoint. Inbound webhooks signed with it stop verifying immediately. Confirm with the user before calling.",
};

/**
 * Every capability input is a `z.object` (a contract invariant), so its `.shape` is the MCP tool's
 * parameter schema — advertised to clients for discovery. The shared handler re-validates the input
 * against the full schema, so this is the discovery surface, not the authoritative gate.
 */
function inputShape(cap: AnyCapability): z.ZodRawShape {
  return (cap.input as z.ZodObject<z.ZodRawShape>).shape;
}

export class WebhookMcp extends McpAgent<McpEnv> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Imported once per DO start in init() (before any tool call runs), so the per-call path opens
  // only a tenant DB client. Definite-assignment: init() always sets these before tools dispatch.
  private cursorKey!: CryptoKey;
  private auditKey!: CryptoKey;
  // The credential hasher (CREDENTIAL_PEPPER) — needed by the WRITE handlers (endpoints.create mints
  // an ingest token inside the DO). Reads never use it; built once in init() like the keys above.
  private hasher!: CredentialHasher;

  /** Structured observability log (mirrors the engine/api `console.log(JSON…)` convention). */
  private log(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ message: event, ...fields }));
  }

  async init(): Promise<void> {
    const [pepper, cursorRaw, auditRaw] = await Promise.all([
      readSecretBinding(this.env.CREDENTIAL_PEPPER),
      readSecretBinding(this.env.CURSOR_KEY),
      readSecretBinding(this.env.AUDIT_CHAIN_HMAC_KEY),
    ]);
    this.hasher = createCredentialHasherFromBase64(pepper);
    [this.cursorKey, this.auditKey] = await Promise.all([
      importCursorKey(b64ToBytes(cursorRaw)),
      importAuditKey(b64ToBytes(auditRaw)),
    ]);

    for (const cap of MCP_BOUND_CAPABILITIES) {
      this.server.registerTool(
        cap.name,
        { description: TOOL_DESCRIPTIONS[cap.name] ?? cap.name, inputSchema: inputShape(cap) },
        async (args: unknown) => {
          const result = await this.runTool(cap.name, args);
          // The single point where an McpToolResult becomes the SDK's (mutable) CallToolResult.
          return {
            content: result.content.map((c) => ({ type: c.type, text: c.text })),
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );
    }
  }

  /** Resolve the grant, run the capability under a per-call tenant client, map every outcome. */
  private async runTool(capabilityName: string, args: unknown): Promise<McpToolResult> {
    let ctx: AuthContext;
    try {
      // The provider already authenticated the token; a malformed grant is a server-side integrity
      // event (a poisoned store or a mint-shape bug). Fail closed with a GENERIC error — the props
      // carry no secret/PII, but we never echo the shape-validation detail to the client — and log it.
      ctx = grantPropsToAuthContext(this.props);
    } catch (err) {
      this.log("mcp.malformed_grant", { error: String(err) });
      return genericToolError();
    }
    // A short-lived RLS-scoped tenant client per call, torn down in finally — never leak a pooled
    // connection (mirrors apps/api + apps/engine). Caching is off on this binding.
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      // The merged read+write capability-handler map, single-sourced in @webhook-co/db (the same map
      // apps/api builds, so the surfaces can't drift). This is load-bearing: endpoints.create
      // auto-registers as a tool (MCP_BOUND_CAPABILITIES), so without the write handlers a call would
      // fall through to the no-handler path. The write handlers mint inside this DO (this.hasher) and
      // validate INGEST_BASE_URL lazily + fail-closed at create time.
      const handlers = buildCapabilityHandlers({
        tenant,
        cursorKey: this.cursorKey,
        auditKey: this.auditKey,
        hasher: this.hasher,
        ingestBaseUrl: this.env.INGEST_BASE_URL,
        // endpoints.delete / endpoints.rotate tools evict the token's hot entry from the engine's ingest
        // cache (ADR-0076). Best-effort: the deleted_at filter + rotated-hash mismatch self-heal within
        // the KV TTL, so a KV blip is logged, never thrown (a throw would lose the rotate URL reveal).
        invalidateIngestHash: makeIngestHashEvictor(kvCredentialCache(this.env.KV_CONFIG), (err) =>
          this.log("mcp.ingest_evict_failed", { error: String(err) }),
        ),
        // endpoints.addProviderSecret tool seals via the engine (the McpAgent never holds the KEK — D1).
        secretSealer: this.env.PROVIDER_SECRET_SEALER,
      });
      return await runCapabilityTool(handlers, capabilityName, ctx, args, (event, fields) =>
        this.log(event, fields),
      );
    } finally {
      await tenant.end();
    }
  }
}
