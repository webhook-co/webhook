import { describe, expect, it } from "vitest";

import { REDACTED, createRedactor, redactWellKnownSecrets } from "./redaction.js";

describe("createRedactor", () => {
  it("replaces a known secret with the placeholder", () => {
    const redact = createRedactor(["whk_supersecretvalue123"]);
    expect(redact("request to host failed with key whk_supersecretvalue123 attached")).toBe(
      `request to host failed with key ${REDACTED} attached`,
    );
  });

  it("replaces every occurrence of a known secret", () => {
    const redact = createRedactor(["sk_abcdef123456"]);
    expect(redact("sk_abcdef123456 then again sk_abcdef123456")).toBe(
      `${REDACTED} then again ${REDACTED}`,
    );
  });

  it("redacts multiple distinct known secrets", () => {
    const redact = createRedactor(["whk_first_secret_aaa", "whsec_second_secret_bbb"]);
    expect(redact("a=whk_first_secret_aaa b=whsec_second_secret_bbb")).toBe(
      `a=${REDACTED} b=${REDACTED}`,
    );
  });

  it("treats a secret with regex-special characters literally (no escaping bugs)", () => {
    const redact = createRedactor(["a.b*c(secret)+value"]);
    expect(redact("leaked a.b*c(secret)+value here")).toBe(`leaked ${REDACTED} here`);
    // A string that would only match if the secret were treated as a regex must NOT be redacted.
    expect(redact("axbYcsecretZvalue")).toBe("axbYcsecretZvalue");
  });

  it("ignores empty or too-short secrets so it never nukes ordinary output", () => {
    const redact = createRedactor(["", "ab"]);
    expect(redact("perfectly ordinary text ab and more")).toBe(
      "perfectly ordinary text ab and more",
    );
  });

  it("still redacts a well-known token even when it was not registered as a known secret", () => {
    const redact = createRedactor(["whk_the_configured_key_xyz"]);
    // A DIFFERENT whk_ token echoed by a server response is caught structurally.
    expect(redact("server said other key whk_someOtherLeakedToken99")).toBe(
      `server said other key ${REDACTED}`,
    );
  });
});

describe("redactWellKnownSecrets", () => {
  it("redacts whk_ API keys", () => {
    expect(redactWellKnownSecrets("token whk_AbC123_def-456 end")).toBe(`token ${REDACTED} end`);
  });

  it("redacts whsec_ signing secrets", () => {
    expect(redactWellKnownSecrets("secret whsec_MFRActualSecretValue done")).toBe(
      `secret ${REDACTED} done`,
    );
  });

  it("redacts a Bearer credential in an Authorization header dump", () => {
    expect(redactWellKnownSecrets("authorization: Bearer abc.def-ghi_123")).toBe(
      "authorization: Bearer [redacted]",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redactWellKnownSecrets("nothing sensitive here, just prose")).toBe(
      "nothing sensitive here, just prose",
    );
  });
});
