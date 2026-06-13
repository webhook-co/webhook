import { SERVICE_NAME } from "@webhook-co/shared";

// Placeholder MCP server entrypoint. The MCP surface lands here, at parity with CLI/API/web.
export const mcpService = `${SERVICE_NAME}:mcp` as const;

// The auth surface: MCP tool calls resolve an AuthContext + enforce the capability's
// scope through this seam, and the server publishes its RFC 9728 protected-resource
// metadata from here. verifyBearer is injected; the impl lives in @webhook-co/db.
export {
  authorize,
  extractBearer,
  protectedResourceMetadata,
  type McpAuthDeps,
  type McpAuthzResult,
} from "./auth";
