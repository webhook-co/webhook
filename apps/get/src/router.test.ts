import { describe, expect, it } from "vitest";

import { handleGet } from "./router.js";

const SCRIPT = "#!/bin/sh\n# wbhk installer\ncurl -fsSL https://get.webhook.co | sh\n";
const u = (p: string): URL => new URL(`https://get.webhook.co${p}`);

describe("handleGet", () => {
  it("serves the install script at /", async () => {
    const res = handleGet(u("/"), SCRIPT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    expect(await res.text()).toBe(SCRIPT);
  });

  it("serves the install script at /install.sh too", async () => {
    const res = handleGet(u("/install.sh"), SCRIPT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SCRIPT);
  });

  it("302-redirects a known asset to the latest release", () => {
    const res = handleGet(u("/wbhk-darwin-arm64"), SCRIPT);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/wbhk-darwin-arm64",
    );
  });

  it("redirects checksums.txt and the .exe", () => {
    expect(handleGet(u("/checksums.txt"), SCRIPT).headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/checksums.txt",
    );
    expect(handleGet(u("/wbhk-windows-x64.exe"), SCRIPT).headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/wbhk-windows-x64.exe",
    );
  });

  it("redirects a versioned asset to that release tag", () => {
    const res = handleGet(u("/v0.3.0/wbhk-linux-x64"), SCRIPT);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/download/cli-v0.3.0/wbhk-linux-x64",
    );
  });

  it("404s unknown paths — no open redirect", () => {
    expect(handleGet(u("/etc/passwd"), SCRIPT).status).toBe(404);
    expect(handleGet(u("/wbhk-evil"), SCRIPT).status).toBe(404);
    expect(handleGet(u("/v0.3.0/evil"), SCRIPT).status).toBe(404);
    expect(handleGet(u("//evil.example.com"), SCRIPT).status).toBe(404);
  });

  it("only ever redirects to the canonical GitHub releases host", () => {
    for (const p of ["/wbhk-linux-x64", "/v1.2.3/checksums.txt", "/wbhk-darwin-x64"]) {
      const loc = handleGet(u(p), SCRIPT).headers.get("location") ?? "";
      expect(loc.startsWith("https://github.com/webhook-co/webhook/releases/")).toBe(true);
    }
  });

  it("sends nosniff + host-scoped HSTS", () => {
    const res = handleGet(u("/"), SCRIPT);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("strict-transport-security")).not.toContain("includeSubDomains");
  });
});
