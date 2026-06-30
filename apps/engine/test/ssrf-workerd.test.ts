import { canonicalizeAndValidateUrl, isBlockedIp } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

// The SSRF guard is the authoritative defense for the engine's connect-time delivery (ADR-0081), so it
// MUST be proven in the REAL Workers runtime (workerd), not just under Node. The guard is hand-rolled
// BigInt arithmetic specifically to avoid node:net BlockList — whose unenv polyfill on workerd has
// unverified membership semantics and could fail OPEN. These tests run under @cloudflare/vitest-pool-
// workers, so a passing run is evidence the deny-list matches (and fails closed) on workerd itself.
describe("SSRF guard under workerd", () => {
  it("blocks loopback / private / metadata / mapped IPs and fails closed on garbage", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "64:ff9b::1.2.3.4",
      "not-an-ip", // fail-closed: unparseable → blocked
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows genuine public IPs (v4 + v6)", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("canonicalizes a valid https URL and rejects IP-literal / non-https / bad-port hosts", () => {
    const ok = canonicalizeAndValidateUrl("https://Hooks.Example.com/in");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.host).toBe("hooks.example.com");
    for (const bad of [
      "http://example.com/in",
      "https://127.0.0.1/in",
      "https://2130706433/in",
      "https://example.com:6379/in",
      "https://localhost/in",
    ]) {
      expect(canonicalizeAndValidateUrl(bad).ok, bad).toBe(false);
    }
  });
});
