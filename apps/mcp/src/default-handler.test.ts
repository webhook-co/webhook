import { describe, expect, it } from "vitest";

import { mcpDefaultHandler } from "./default-handler";
import type { McpEnv } from "./env";

const env = {} as McpEnv;
const get = (path: string) =>
  mcpDefaultHandler.fetch(new Request(`https://mcp.webhook.co${path}`), env);

describe("mcpDefaultHandler", () => {
  it("returns 501 for /authorize (the login + consent UI lands in WS-D2b)", async () => {
    expect((await get("/authorize")).status).toBe(501);
  });

  it("answers /healthz with 200", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mcp ok");
  });

  it("returns 404 for unknown non-API paths", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});
