import { describe, expect, it } from "vitest";

import { resolveProxy } from "./proxy.js";

const API = "https://api.webhook.co";
const TUNNEL = "wss://wbhk.my/listen";

describe("resolveProxy", () => {
  it("uses HTTPS_PROXY for an https target", () => {
    expect(resolveProxy(API, { HTTPS_PROXY: "http://proxy:8080" })).toBe("http://proxy:8080");
  });

  it("uses HTTPS_PROXY for a wss target (wss is secure)", () => {
    expect(resolveProxy(TUNNEL, { HTTPS_PROXY: "http://proxy:8080" })).toBe("http://proxy:8080");
  });

  it("uses HTTP_PROXY for an http/ws target, not HTTPS_PROXY", () => {
    expect(
      resolveProxy("http://localhost:8787", {
        HTTP_PROXY: "http://p:1",
        HTTPS_PROXY: "http://p:2",
      }),
    ).toBe("http://p:1");
  });

  it("honors lowercase env names", () => {
    expect(resolveProxy(API, { https_proxy: "http://lower:8080" })).toBe("http://lower:8080");
  });

  it("falls back to ALL_PROXY when the scheme-specific var is unset", () => {
    expect(resolveProxy(API, { ALL_PROXY: "http://all:9090" })).toBe("http://all:9090");
  });

  it("returns undefined when no proxy var is set", () => {
    expect(resolveProxy(API, {})).toBeUndefined();
  });

  it("NO_PROXY=* disables proxying entirely", () => {
    expect(resolveProxy(API, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "*" })).toBeUndefined();
  });

  it("NO_PROXY suffix-matches the target host (bare + leading-dot forms)", () => {
    expect(
      resolveProxy(API, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "webhook.co" }),
    ).toBeUndefined();
    expect(
      resolveProxy(TUNNEL, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "other.com, .wbhk.my" }),
    ).toBeUndefined();
  });

  it("does NOT exclude a host that only partially matches a NO_PROXY entry", () => {
    // "hook.co" must not match "webhook.co" (suffix match is dot-bounded)
    expect(resolveProxy(API, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "hook.co" })).toBe(
      "http://proxy:8080",
    );
  });

  it("excludes an exact host match in NO_PROXY", () => {
    expect(
      resolveProxy(API, { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "api.webhook.co" }),
    ).toBeUndefined();
  });

  it("a whitespace-only UPPER var does not shadow a real lowercase var", () => {
    expect(resolveProxy(API, { HTTPS_PROXY: "   ", https_proxy: "http://lower:8080" })).toBe(
      "http://lower:8080",
    );
  });

  it("returns undefined for an unparseable target", () => {
    expect(resolveProxy("not a url", { HTTPS_PROXY: "http://proxy:8080" })).toBeUndefined();
  });
});
