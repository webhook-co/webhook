import { describe, expect, it } from "vitest";

import { canonicalizeAndValidateUrl, isBlockedIp } from "./ssrf";

describe("canonicalizeAndValidateUrl", () => {
  it("accepts a normal https URL and lowercases the host + strips the default port", () => {
    const r = canonicalizeAndValidateUrl("https://API.Example.COM:443/webhooks/in?x=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe("api.example.com");
      // default https port (443) is normalized away; path + query preserved; host lowercased
      expect(r.url).toBe("https://api.example.com/webhooks/in?x=1");
    }
  });

  it("preserves a non-default allowed port (8443)", () => {
    const r = canonicalizeAndValidateUrl("https://hooks.example.com:8443/in");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://hooks.example.com:8443/in");
  });

  it("rejects non-https schemes", () => {
    for (const u of [
      "http://example.com/in",
      "ftp://example.com/in",
      "file:///etc/passwd",
      "gopher://example.com/",
    ]) {
      expect(canonicalizeAndValidateUrl(u).ok, u).toBe(false);
    }
  });

  it("rejects embedded credentials (userinfo)", () => {
    expect(canonicalizeAndValidateUrl("https://user:pass@example.com/in").ok).toBe(false);
    expect(canonicalizeAndValidateUrl("https://user@example.com/in").ok).toBe(false);
  });

  it("rejects IP-literal hosts (v4 + bracketed v6)", () => {
    for (const u of [
      "https://93.184.216.34/in",
      "https://[2606:4700:4700::1111]/in",
      "https://[::1]/in",
      "https://127.0.0.1/in",
    ]) {
      expect(canonicalizeAndValidateUrl(u).ok, u).toBe(false);
    }
  });

  it("rejects the IP-encoding zoo (decimal/octal/hex/short-form all canonicalize to an IP literal)", () => {
    for (const u of [
      "https://2130706433/in", // decimal 127.0.0.1
      "https://0x7f000001/in", // hex 127.0.0.1
      "https://0177.0.0.1/in", // octal 127.0.0.1
      "https://127.1/in", // short-form 127.0.0.1
      "https://0/in", // 0.0.0.0
    ]) {
      expect(canonicalizeAndValidateUrl(u).ok, u).toBe(false);
    }
  });

  it("rejects a disallowed port even on a real hostname", () => {
    for (const u of [
      "https://example.com:22/in",
      "https://example.com:25/in",
      "https://example.com:6379/in",
      "https://example.com:5432/in",
      "https://example.com:8080/in",
    ]) {
      expect(canonicalizeAndValidateUrl(u).ok, u).toBe(false);
    }
  });

  it("rejects a single-label host (no public FQDN) such as localhost", () => {
    expect(canonicalizeAndValidateUrl("https://localhost/in").ok).toBe(false);
    expect(canonicalizeAndValidateUrl("https://intranet/in").ok).toBe(false);
  });

  it("strips trailing dot(s) to a canonical host (single + multi-dot dedupe to the same form)", () => {
    for (const u of ["https://example.com./in", "https://example.com../in"]) {
      const r = canonicalizeAndValidateUrl(u);
      expect(r.ok, u).toBe(true);
      if (r.ok) expect(r.host).toBe("example.com");
    }
  });

  it("rejects an empty label (leading dot or consecutive dots)", () => {
    for (const u of ["https://example..com/in", "https://.example.com/in"]) {
      expect(canonicalizeAndValidateUrl(u).ok, u).toBe(false);
    }
  });

  it("normalizes an IDN host to punycode and accepts a valid punycode host", () => {
    // a unicode host is converted to ASCII punycode by WHATWG URL
    const u = canonicalizeAndValidateUrl("https://bücher.example.com/in");
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.host).toBe("xn--bcher-kva.example.com");
    // an already-punycode host is accepted as-is
    const r = canonicalizeAndValidateUrl("https://xn--bcher-kva.example.com/in");
    expect(r.ok).toBe(true);
  });

  it("rejects unparseable / empty input (fail closed)", () => {
    for (const u of ["", "   ", "not a url", "https://", "https:// space.com/"]) {
      expect(canonicalizeAndValidateUrl(u).ok, JSON.stringify(u)).toBe(false);
    }
  });
});

describe("isBlockedIp", () => {
  it("blocks IPv4 private / loopback / link-local / metadata / CGNAT / special ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "169.254.0.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "192.0.2.1", // TEST-NET-1
      "198.18.0.1", // benchmarking
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback / unspecified / link-local / ULA / multicast", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00::1", // ULA (inside fc00::/7)
      "ff02::1",
      "2001:db8::1", // documentation
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks IPv4-mapped/compatible IPv6 carrying a private v4 (embedded re-check)", () => {
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::169.254.169.254", // deprecated v4-compatible
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks exotic IPv6 transition prefixes outright (NAT64 / 6to4 / Teredo)", () => {
    for (const ip of [
      "64:ff9b::1.2.3.4", // NAT64 well-known
      "64:ff9b:1::1", // NAT64 local-use
      "2002:c0a8:0101::1", // 6to4 wrapping 192.168.1.1
      "2001:0:1:2:3:4:5:6", // Teredo
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows genuine public IPv6 (Google DNS, Cloudflare)", () => {
    for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("treats unparseable input as blocked (fail closed)", () => {
    for (const ip of ["", "not-an-ip", "999.999.999.999", "12.34", "::gg"]) {
      expect(isBlockedIp(ip), JSON.stringify(ip)).toBe(true);
    }
  });
});
