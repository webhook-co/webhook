import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../bytes";
import type { VerifyAdapter } from "../adapter";
import { shopifyAdapter } from "./shopify";
import { slackAdapter } from "./slack";
import { standardWebhooksAdapter } from "./standard-webhooks";

// Shopify/Slack/Standard-Webhooks are scaffolded follow-ups: structure + documented
// construction, no signature math yet. They must still behave honestly — diagnose,
// never throw, never falsely claim ok — so capture/ACK is never blocked.
const scaffolds: Array<[string, VerifyAdapter]> = [
  ["shopify", shopifyAdapter],
  ["slack", slackAdapter],
  ["standard_webhooks", standardWebhooksAdapter],
];

describe.each(scaffolds)("%s scaffold", (scheme, adapter) => {
  it("reports its scheme and a lowercase signature header", () => {
    expect(adapter.scheme).toBe(scheme);
    expect(adapter.signatureHeader).toBe(adapter.signatureHeader.toLowerCase());
    expect(adapter.toleranceSeconds).toBeGreaterThan(0);
  });

  it("diagnoses a missing signature header", async () => {
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode("{}"),
      headers: [["content-type", "application/json"]],
      secrets: ["s"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("MISSING_HEADER");
      if (result.reason.code === "MISSING_HEADER") {
        expect(result.reason.header).toBe(adapter.signatureHeader);
      }
    }
  });

  it("returns an honest UNSUPPORTED_SCHEME (not a false ok) when the header IS present", async () => {
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode("{}"),
      headers: [[adapter.signatureHeader, "whatever"]],
      secrets: ["s"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("UNSUPPORTED_SCHEME");
  });
});
