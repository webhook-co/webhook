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

describe("boolean params", () => {
  it("serialises booleans and SENDS an explicit false (only undefined is omitted)", () => {
    expect(withQuery("/v1/triggers/t1/wait", { includeBody: true })).toBe(
      "/v1/triggers/t1/wait?includeBody=true",
    );
    expect(withQuery("/v1/triggers/t1/wait", { includeBody: false })).toBe(
      "/v1/triggers/t1/wait?includeBody=false",
    );
    expect(withQuery("/v1/triggers/t1/wait", { includeBody: undefined })).toBe(
      "/v1/triggers/t1/wait",
    );
  });

  // A caught-up triggers.wait returns `nextCursor: null`, and the contract makes the cursor INPUT nullable
  // precisely so that value round-trips straight back in. If null serialised, we would send the literal
  // string "null" and the server would reject it as a malformed cursor.
  it("omits a null param (a caught-up nextCursor must round-trip back in)", () => {
    expect(withQuery("/v1/triggers/t1/wait", { cursor: null })).toBe("/v1/triggers/t1/wait");
  });
});
