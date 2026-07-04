import { describe, expect, it } from "vitest";

import { withQuery } from "./query.js";

describe("withQuery", () => {
  it("returns the path unchanged when there are no defined params", () => {
    expect(withQuery("/v1/endpoints", {})).toBe("/v1/endpoints");
    expect(withQuery("/v1/endpoints", { cursor: undefined, limit: undefined })).toBe(
      "/v1/endpoints",
    );
  });

  it("appends string and numeric params", () => {
    expect(withQuery("/v1/endpoints", { name: "prod", limit: 50 })).toBe(
      "/v1/endpoints?name=prod&limit=50",
    );
  });

  it("repeats an array value as multiple params", () => {
    expect(withQuery("/v1/deliveries", { status: ["failed", "pending"] })).toBe(
      "/v1/deliveries?status=failed&status=pending",
    );
  });

  it("omits an empty array entirely", () => {
    expect(withQuery("/v1/deliveries", { status: [], destinationId: "d1" })).toBe(
      "/v1/deliveries?destinationId=d1",
    );
  });

  it("url-encodes reserved characters", () => {
    expect(withQuery("/v1/endpoints", { name: "a b&c" })).toBe("/v1/endpoints?name=a+b%26c");
  });
});
