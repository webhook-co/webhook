import { describe, expect, it } from "vitest";

import { mapProviderTokenError } from "./token-error";

// A2b-2b — the provider error code is the one piece of pure logic in the deps glue: it sanitizes the
// provider's /oauth/token error to our OAuthErrorCode so no provider free-text or unexpected code reaches
// the client, and a failed auth-code exchange never masquerades as anything but a bad grant.

describe("mapProviderTokenError", () => {
  it("passes through the request/scope/target codes verbatim", () => {
    expect(mapProviderTokenError("invalid_request")).toBe("invalid_request");
    expect(mapProviderTokenError("invalid_scope")).toBe("invalid_scope");
    expect(mapProviderTokenError("invalid_target")).toBe("invalid_target");
  });

  it("collapses everything else (incl. client/grant-type/unknown/undefined) to invalid_grant", () => {
    expect(mapProviderTokenError("invalid_grant")).toBe("invalid_grant");
    expect(mapProviderTokenError("invalid_client")).toBe("invalid_grant");
    expect(mapProviderTokenError("unsupported_grant_type")).toBe("invalid_grant");
    expect(mapProviderTokenError("something_unexpected")).toBe("invalid_grant");
    expect(mapProviderTokenError(undefined)).toBe("invalid_grant");
  });
});
