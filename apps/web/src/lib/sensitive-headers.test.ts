import { describe, expect, it } from "vitest";

import { isSensitiveHeader } from "./sensitive-headers";

// Fail-closed: anything NOT on the canonical safe allowlist (@webhook-co/shared LOGGABLE_HEADER_ALLOWLIST)
// is sensitive — masked + revealed on demand. So unrecognized headers default to sensitive (no leak).

describe("isSensitiveHeader", () => {
  it.each([
    // known-sensitive classes
    "Authorization",
    "Cookie",
    "Set-Cookie",
    "X-Api-Key",
    "Stripe-Signature",
    "X-Hub-Signature-256",
    "X-Shopify-Hmac-SHA256",
    "Paypal-Transmission-Sig",
    // names a denylist would have MISSED — fail-closed catches them anyway
    "X-Access-Key",
    "X-Encryption-Key",
    "X-Vendor-Credential",
    // a truly-unknown header still masks (fail-closed)
    "X-Some-Vendor-Blob",
  ])("treats %s as sensitive (not on the safe allowlist)", (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each([
    // the canonical log-boundary allowlist (shown inline, no reveal needed)
    "Content-Type",
    "content-length",
    "User-Agent",
    "Accept",
    "Accept-Encoding",
    "Host",
    "Date",
    "Webhook-Id",
    "X-GitHub-Event",
    "X-GitHub-Delivery",
    "X-Shopify-Topic",
    // the inspector's widened benign request headers (routing / client identity)
    "X-Forwarded-For",
    "X-Real-IP",
    "X-Request-Id",
    "CF-Ray",
    "Accept-Language",
    "Referer",
    "Origin",
  ])("treats %s as non-sensitive (on the safe allowlist)", (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});
