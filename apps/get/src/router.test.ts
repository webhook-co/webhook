import { describe, expect, it } from "vitest";

import { handleGet } from "./router.js";

const u = (p: string): URL => new URL(`https://get.webhook.co${p}`);
const INSTALL_SH =
  "https://raw.githubusercontent.com/webhook-co/webhook/main/packages/cli/scripts/install.sh";

describe("handleGet", () => {
  it("302-redirects / to the canonical install script", () => {
    const res = handleGet(u("/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(INSTALL_SH);
  });

  it("302-redirects /install.sh too", () => {
    expect(handleGet(u("/install.sh")).headers.get("location")).toBe(INSTALL_SH);
  });

  it("302-redirects a known asset to the latest release", () => {
    const res = handleGet(u("/wbhk-darwin-arm64"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/wbhk-darwin-arm64",
    );
  });

  it("redirects checksums.txt and the .exe", () => {
    expect(handleGet(u("/checksums.txt")).headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/checksums.txt",
    );
    expect(handleGet(u("/wbhk-windows-x64.exe")).headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/latest/download/wbhk-windows-x64.exe",
    );
  });

  it("redirects a versioned asset to that release tag", () => {
    const res = handleGet(u("/v0.3.0/wbhk-linux-x64"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/webhook-co/webhook/releases/download/cli-v0.3.0/wbhk-linux-x64",
    );
  });

  it("404s unknown paths — no open redirect", () => {
    expect(handleGet(u("/etc/passwd")).status).toBe(404);
    expect(handleGet(u("/wbhk-evil")).status).toBe(404);
    expect(handleGet(u("/v0.3.0/evil")).status).toBe(404);
    expect(handleGet(u("//evil.example.com")).status).toBe(404);
  });

  it("only ever redirects to canonical github hosts (no open redirect)", () => {
    const allowed = (loc: string): boolean =>
      loc.startsWith("https://github.com/webhook-co/webhook/releases/") || loc === INSTALL_SH;
    for (const p of ["/", "/install.sh", "/wbhk-linux-x64", "/v1.2.3/checksums.txt"]) {
      expect(allowed(handleGet(u(p)).headers.get("location") ?? "")).toBe(true);
    }
  });

  it("sends nosniff + host-scoped HSTS on the redirect", () => {
    const res = handleGet(u("/"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("strict-transport-security")).not.toContain("includeSubDomains");
  });
});
