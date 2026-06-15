import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AnyCapability, AuthContext } from "@webhook-co/contract";
import { createClient, createReadHandlers } from "@webhook-co/db";
import { b64ToBytes, importAuditKey, importCursorKey } from "@webhook-co/shared";
import type { z } from "zod";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";
import { grantPropsToAuthContext } from "./grant";
import { genericToolError, runCapabilityTool, type McpToolResult } from "./tools";
import type { McpEnv } from "./env";

// The webhook.co MCP server as a Cloudflare Agent (Durable Object). It registers the read
// capabilities (MCP_BOUND_CAPABILITIES) as MCP tools, each binding the SHARED createReadHandlers
// map — the very same handlers apps/api dispatches over HTTP, so the two surfaces can't drift.
//
// Auth: the OAuthProvider validates the bearer (a provider-minted token, or — today — an api key
// resolved via resolveExternalToken) and exposes the grant as `this.props`; grantPropsToAuthContext
// re-validates that shape into an AuthContext at the trust boundary (grant.ts). Each tool then runs
// the shared handler under RLS with a per-call tenant client. NO fault is ever thrown out of a tool
// handler — the MCP SDK would echo the message to the client — so a malformed grant or an
// operational fault is logged and returned as a generic, leak-free error (see tools.ts). The
// cursor/audit HMAC keys are imported once per DO start (init).
//
// SESSION BINDING (security): the McpAgent Durable Object is keyed by the `Mcp-Session-Id`, and
// `this.props` is set ONCE — from the grant of the request that INITIALIZES the session (McpAgent
// `onStart`; warm requests don't refresh it). So a session is bound to its initializing principal,
// and the session id is a bearer-equivalent secret: the platform mints it unguessably and returns
// it only to that caller. Reusing another principal's session id (to read THEIR org) therefore
// requires stealing that secret. We do NOT additionally re-bind the principal per request here,
// because the streamable-HTTP handler routes purely by session id and does not surface the
// per-request grant to the tool handler. This is acceptable while callers are org-scoped api keys
// that each open their own session; cross-principal session reuse becomes reachable only once the
// deferred OAuth user-login mints multi-user tokens — harden then (principal-namespaced session
// routing, or a per-request principal re-check). Tracked as a follow-up; see ADR-0011.

const SERVER_NAME = "webhook.co";
const SERVER_VERSION = "0.0.0";

/** Concise, agent-facing descriptions for the bound read tools (MCP tool discovery). */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "endpoints.list": "List the org's webhook endpoints (paginated).",
  "endpoints.get": "Get a single webhook endpoint by id.",
  "events.list": "List received events for an endpoint (paginated; optional provider filter).",
  "events.get": "Get a received event by id — headers, verification result, and payload pointer.",
  "events.tail":
    "Tail an endpoint's events forward from a cursor (oldest-first, up to the safety watermark); pass the returned nextCursor back to continue.",
  "audit.verify": "Verify the org's tamper-evident audit chain; reports the first break, if any.",
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

  /** Structured observability log (mirrors the engine/api `console.log(JSON…)` convention). */
  private log(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ message: event, ...fields }));
  }

  async init(): Promise<void> {
    [this.cursorKey, this.auditKey] = await Promise.all([
      importCursorKey(b64ToBytes(this.env.CURSOR_KEY)),
      importAuditKey(b64ToBytes(this.env.AUDIT_CHAIN_HMAC_KEY)),
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
      const handlers = createReadHandlers({
        tenant,
        cursorKey: this.cursorKey,
        auditKey: this.auditKey,
      });
      return await runCapabilityTool(handlers, capabilityName, ctx, args, (event, fields) =>
        this.log(event, fields),
      );
    } finally {
      await tenant.end();
    }
  }
}
