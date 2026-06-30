import { describe, expect, it } from "vitest";

import { filterDeliveryHeaders } from "./delivery-headers";

describe("filterDeliveryHeaders", () => {
  it("drops hop-by-hop / host / content-length and keeps everything else (incl. webhook-* signatures)", () => {
    const h = filterDeliveryHeaders([
      ["Host", "wbhk.my"],
      ["Content-Length", "123"],
      ["Connection", "keep-alive"],
      ["Transfer-Encoding", "chunked"],
      ["Webhook-Id", "msg_123"],
      ["Webhook-Signature", "v1,abc"],
      ["Content-Type", "application/json"],
    ]);
    expect(h.get("host")).toBeNull();
    expect(h.get("content-length")).toBeNull();
    expect(h.get("connection")).toBeNull();
    expect(h.get("transfer-encoding")).toBeNull();
    expect(h.get("webhook-id")).toBe("msg_123");
    expect(h.get("webhook-signature")).toBe("v1,abc");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("is case-insensitive on the dropped header names", () => {
    const h = filterDeliveryHeaders([
      ["HOST", "x"],
      ["content-length", "1"],
      ["X-Custom", "keep"],
    ]);
    expect(h.get("host")).toBeNull();
    expect(h.get("content-length")).toBeNull();
    expect(h.get("x-custom")).toBe("keep");
  });
});
