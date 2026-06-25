import { CapabilityFault, type AuthContext } from "@webhook-co/contract";
import type { CapabilityHandlers } from "@webhook-co/db";

// The MCP transport adapter for a read capability. It dispatches to the SHARED read handler
// (the same map apps/api binds), then maps the outcome to an MCP tool result. Crucially it NEVER
// THROWS: the MCP SDK turns any thrown handler error into an isError tool result echoing the raw
// error.message to the client (server/mcp.js -> createToolError), which would leak internals and
// skip our observability log. So we map outcomes ourselves:
//   * success                 -> a text content block carrying the contract-shaped JSON output
//   * CapabilityFault          -> an isError result carrying the closed-taxonomy code (client-facing,
//                                 the MCP analogue of the API surface's fault->status map)
//   * operational fault / bug  -> logged to observability + a GENERIC isError ("internal error"),
//                                 mirroring apps/api's masked 500 + api.unhandled log (internals
//                                 never reach the caller).
// Keeping this pure (handlers + ctx + input + log in, result out) means dispatch + every error
// mapping is node-tested with no Durable Object, MCP transport, or DB; the read logic itself is
// tested in the db pool (packages/db).

/** An MCP tool result: text content, optionally flagged as an error. */
export interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

/** Structured observability sink (event name + fields), mirroring the engine/api log shape. */
export type ToolLog = (event: string, fields: Record<string, unknown>) => void;

/** A generic, leak-free tool error for operational/wiring faults (internals go to logs only). */
export function genericToolError(): McpToolResult {
  return { content: [{ type: "text", text: "internal error" }], isError: true };
}

/** A client-facing capability fault rendered for the wire: the closed-taxonomy code + its message. */
function faultResult(fault: CapabilityFault): McpToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: fault.code, message: fault.message }) },
    ],
    isError: true,
  };
}

export async function runCapabilityTool(
  handlers: CapabilityHandlers,
  capabilityName: string,
  ctx: AuthContext,
  input: unknown,
  log: ToolLog,
): Promise<McpToolResult> {
  const handler = handlers.get(capabilityName);
  if (handler === undefined) {
    // A registered tool with no bound handler is a wiring bug — record it loudly, return generic.
    log("mcp.no_handler", { capability: capabilityName });
    return genericToolError();
  }
  try {
    const output = await handler(ctx, input);
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (err) {
    if (err instanceof CapabilityFault) {
      return faultResult(err); // typed, client-facing — surface the code, never an internal
    }
    // Operational fault (DB/Hyperdrive outage, a bug): log it, return a generic, leak-free error.
    log("mcp.tool_unhandled", { capability: capabilityName, error: String(err) });
    return genericToolError();
  }
}
