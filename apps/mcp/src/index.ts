import { SERVICE_NAME } from "@webhook-co/shared";

// Placeholder MCP server entrypoint. The MCP surface lands here, at parity with CLI/API/web.
export const mcpService = `${SERVICE_NAME}:mcp` as const;
