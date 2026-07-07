import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("engine worker", () => {
  it("runs inside the Workers runtime (workerd globals available)", () => {
    // crypto.subtle is a Workers-runtime global; its presence proves the test
    // executes in workerd rather than plain Node.
    expect(typeof crypto.subtle.digest).toBe("function");
  });

  it("serves a 200 liveness probe at /healthz", async () => {
    const response = await SELF.fetch("https://engine.example/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
  });

  it("302-redirects the bare root to the marketing homepage", async () => {
    // redirect: "manual" so we observe the 302 itself rather than following it off to www.webhook.co.
    const response = await SELF.fetch("https://engine.example/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://www.webhook.co/");
  });
});
