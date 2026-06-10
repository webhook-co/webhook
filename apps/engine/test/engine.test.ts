import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("engine worker", () => {
  it("runs inside the Workers runtime (workerd globals available)", () => {
    // crypto.subtle is a Workers-runtime global; its presence proves the test
    // executes in workerd rather than plain Node.
    expect(typeof crypto.subtle.digest).toBe("function");
  });

  it("responds to a fetch with a 200", async () => {
    const response = await SELF.fetch("https://engine.example/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("engine ok");
  });
});
