import { describe, expect, it } from "vitest";

import worker, { type Env } from "./index.js";

// The public, DB-free routes are served before any tenant deps are built, so they're
// exercised through the real default export with a dummy Env (env is never read on these paths).
const dummyEnv = {} as Env;

describe("apps/api worker — public routes (no auth, no DB deps)", () => {
  it("serves the RFC 9728 protected-resource metadata", async () => {
    const res = await worker.fetch(
      new Request("https://api.webhook.co/.well-known/oauth-protected-resource"),
      dummyEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe("https://api.webhook.co");
    expect(body.authorization_servers).toContain("https://auth.webhook.co"); // the Lane C issuer (A8)
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves a health check at GET /", async () => {
    const res = await worker.fetch(new Request("https://api.webhook.co/"), dummyEnv);
    expect(res.status).toBe(200);
  });
});
