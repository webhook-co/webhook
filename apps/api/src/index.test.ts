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

  it("serves the OpenAPI 3.1 spec unauthenticated + CORS-open at GET /openapi.json", async () => {
    const res = await worker.fetch(new Request("https://api.webhook.co/openapi.json"), dummyEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const spec = (await res.json()) as { openapi: string; info: { title: string }; paths: object };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("webhook.co API");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it("does not serve a built-in docs UI (reference docs are rendered by Mintlify off the spec)", async () => {
    // The api Worker publishes only the machine-readable spec; human docs live on docs.webhook.co (Mintlify,
    // internal ADR-0006). A /docs path is therefore not a public route — it falls through to the router.
    const res = await worker.fetch(new Request("https://api.webhook.co/docs"), dummyEnv);
    expect(res.status).not.toBe(200);
  });
});
