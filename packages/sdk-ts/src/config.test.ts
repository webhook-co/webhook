import { describe, expect, it } from "vitest";

import { DEFAULT_BASE_URL, resolveBaseUrl } from "./config.js";
import { WebhookConfigError } from "./errors.js";

describe("resolveBaseUrl", () => {
  it("defaults to the hosted API", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.webhook.co");
    expect(resolveBaseUrl(undefined)).toBe("https://api.webhook.co");
  });

  it("accepts an https origin and strips a trailing slash", () => {
    expect(resolveBaseUrl("https://api.webhook.co/")).toBe("https://api.webhook.co");
  });

  it("preserves a base path", () => {
    expect(resolveBaseUrl("https://example.test/api/")).toBe("https://example.test/api");
  });

  it("allows plaintext http only for loopback (local dev / self-host)", () => {
    expect(resolveBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(resolveBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("rejects plaintext http to a non-loopback host (credential downgrade)", () => {
    expect(() => resolveBaseUrl("http://api.webhook.co")).toThrow(WebhookConfigError);
  });

  it("rejects a URL carrying a query or fragment", () => {
    expect(() => resolveBaseUrl("https://api.webhook.co?x=1")).toThrow(WebhookConfigError);
    expect(() => resolveBaseUrl("https://api.webhook.co#frag")).toThrow(WebhookConfigError);
  });

  it("rejects an unparseable URL", () => {
    expect(() => resolveBaseUrl("not a url")).toThrow(WebhookConfigError);
  });
});
