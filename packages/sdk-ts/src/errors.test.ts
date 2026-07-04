import { describe, expect, it } from "vitest";

import {
  DEFAULT_MESSAGE,
  WebhookAPIError,
  WebhookAuthenticationError,
  WebhookConflictError,
  WebhookConnectionError,
  WebhookError,
  WebhookInvalidRequestError,
  WebhookNotFoundError,
  WebhookPermissionError,
  WebhookRateLimitError,
  WebhookTargetUnreachableError,
  WebhookUnexpectedResponseError,
  codeForStatus,
  errorFromResponse,
  errorFromTransport,
} from "./errors.js";

describe("codeForStatus", () => {
  it("maps each modelled status to its capability code", () => {
    expect(codeForStatus(400)).toBe("VALIDATION_ERROR");
    expect(codeForStatus(401)).toBe("UNAUTHORIZED");
    expect(codeForStatus(403)).toBe("FORBIDDEN");
    expect(codeForStatus(404)).toBe("NOT_FOUND");
    expect(codeForStatus(409)).toBe("ENDPOINT_PAUSED");
    expect(codeForStatus(429)).toBe("RATE_LIMITED");
    expect(codeForStatus(502)).toBe("TARGET_UNREACHABLE");
  });

  it("returns undefined for an unmodelled status", () => {
    expect(codeForStatus(500)).toBeUndefined();
    expect(codeForStatus(418)).toBeUndefined();
  });
});

describe("errorFromResponse", () => {
  it("selects the right subclass per status and carries code + status", () => {
    const cases: Array<[number, new (...a: never[]) => WebhookError, string]> = [
      [400, WebhookInvalidRequestError, "VALIDATION_ERROR"],
      [401, WebhookAuthenticationError, "UNAUTHORIZED"],
      [403, WebhookPermissionError, "FORBIDDEN"],
      [404, WebhookNotFoundError, "NOT_FOUND"],
      [409, WebhookConflictError, "ENDPOINT_PAUSED"],
      [429, WebhookRateLimitError, "RATE_LIMITED"],
      [502, WebhookTargetUnreachableError, "TARGET_UNREACHABLE"],
    ];
    for (const [status, ctor, code] of cases) {
      const err = errorFromResponse({ status });
      expect(err).toBeInstanceOf(ctor);
      expect(err).toBeInstanceOf(WebhookAPIError);
      expect(err).toBeInstanceOf(WebhookError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe(DEFAULT_MESSAGE[code as keyof typeof DEFAULT_MESSAGE]);
    }
  });

  it("prefers a server-supplied message over the default", () => {
    const err = errorFromResponse({ status: 400, message: "endpoint name is required" });
    expect(err.message).toBe("endpoint name is required");
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("threads requestId and a rate-limit retry delay", () => {
    const err = errorFromResponse({ status: 429, requestId: "req_abc", retryAfterMs: 5000 });
    expect(err).toBeInstanceOf(WebhookRateLimitError);
    expect((err as WebhookRateLimitError).retryAfterMs).toBe(5000);
    expect(err.requestId).toBe("req_abc");
  });

  it("prefers an explicit body code over the status-derived one", () => {
    // Body said NOT_FOUND even though the transport status was a bare 400 — trust the envelope code.
    const err = errorFromResponse({ status: 400, code: "NOT_FOUND" });
    expect(err).toBeInstanceOf(WebhookNotFoundError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(400);
  });

  it("falls back to an unexpected-response error for an unmodelled status", () => {
    const err = errorFromResponse({ status: 500 });
    expect(err).toBeInstanceOf(WebhookUnexpectedResponseError);
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
  });
});

describe("errorFromTransport", () => {
  it("is a connection error naming the base URL, with no status or code", () => {
    const err = errorFromTransport("https://api.webhook.co");
    expect(err).toBeInstanceOf(WebhookConnectionError);
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.message).toContain("https://api.webhook.co");
  });
});
