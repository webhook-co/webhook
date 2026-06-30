import { describe, expect, it } from "vitest";

import {
  DeliveryAttemptSchema,
  deriveVerificationState,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  OrgSchema,
  ReplayDestinationSchema,
} from "./entities";

const uuid = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

describe("deriveVerificationState", () => {
  it("maps the (verified, verification) pair to the truthful tri-state", () => {
    expect(deriveVerificationState(true, { ok: true })).toBe("verified");
    // verified=false WITH a non-null verification = an adapter ran and rejected.
    expect(deriveVerificationState(false, { ok: false, reason: { code: "WRONG_SECRET" } })).toBe(
      "failed",
    );
    // verification IS NULL = no signature was checked (no secret / header absent / KMS error).
    expect(deriveVerificationState(false, null)).toBe("unattempted");
    expect(deriveVerificationState(false, undefined)).toBe("unattempted");
  });

  it("is OPTIONAL on EventSummary — a row without it still parses (version-skew safe)", () => {
    const parsed = EventSummarySchema.parse({
      id: uuid,
      orgId: uuid,
      endpointId: uuid,
      receivedAt: "2026-06-28T00:00:00.000Z",
      provider: "stripe",
      dedupKey: "dk",
      dedupStrategy: "sw_webhook_id",
      verified: true,
      // no verificationState
    });
    expect(parsed.verificationState).toBeUndefined();
  });
});

describe("entity schemas", () => {
  it("parses an Org and coerces an ISO date string", () => {
    const org = OrgSchema.parse({
      id: uuid,
      slug: "acme",
      name: "Acme",
      region: "us",
      createdAt: "2026-06-12T20:00:00.000Z",
    });
    expect(org.createdAt).toBeInstanceOf(Date);
  });

  it("rejects a non-uuid id", () => {
    expect(() =>
      EndpointSchema.parse({
        id: "nope",
        orgId: uuid,
        name: "ep",
        paused: false,
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it("parses a full Event including the verification union", () => {
    const event = EventSchema.parse({
      id: uuid,
      orgId: uuid,
      endpointId: uuid,
      receivedAt: new Date(),
      provider: "stripe",
      dedupKey: "evt_1",
      dedupStrategy: "provider_event_id",
      verified: true,
      payloadR2Key: "org/x/ep/y/abc",
      payloadBytes: 128,
      contentType: "application/json",
      headers: [["content-type", "application/json"]],
      providerEventId: "evt_1",
      externalId: null,
      verification: { ok: true, keyId: "k1", scheme: "stripe" },
    });
    expect(event.verification).toEqual({ ok: true, keyId: "k1", scheme: "stripe" });
  });

  it("accepts an EventSummary with a null provider", () => {
    const s = EventSummarySchema.parse({
      id: uuid,
      orgId: uuid,
      endpointId: uuid,
      receivedAt: new Date(),
      provider: null,
      dedupKey: "h",
      dedupStrategy: "content_hash",
      verified: false,
    });
    expect(s.provider).toBeNull();
  });

  it("rejects an unknown dedup strategy", () => {
    expect(() =>
      EventSummarySchema.parse({
        id: uuid,
        orgId: uuid,
        endpointId: uuid,
        receivedAt: new Date(),
        provider: null,
        dedupKey: "h",
        dedupStrategy: "made_up",
        verified: false,
      }),
    ).toThrow();
  });

  it("parses a DeliveryAttempt with a null idempotency key", () => {
    const da = DeliveryAttemptSchema.parse({
      id: uuid,
      orgId: uuid,
      eventId: uuid,
      target: "localhost-tunnel",
      idempotencyKey: null,
      status: "delivered",
      statusCode: 200,
      attempt: 1,
      error: null,
      createdAt: new Date(),
    });
    expect(da.attempt).toBe(1);
  });

  it("parses a ReplayDestination (active, never-validated) and coerces dates", () => {
    const d = ReplayDestinationSchema.parse({
      id: uuid,
      orgId: uuid,
      url: "https://hooks.example.com/in",
      label: "prod receiver",
      status: "active",
      createdAt: "2026-06-30T00:00:00.000Z",
      lastValidatedAt: null,
    });
    expect(d.status).toBe("active");
    expect(d.createdAt).toBeInstanceOf(Date);
    expect(d.lastValidatedAt).toBeNull();
  });

  it("rejects a ReplayDestination with an unknown status (closed enum)", () => {
    expect(
      ReplayDestinationSchema.safeParse({
        id: uuid,
        orgId: uuid,
        url: "https://hooks.example.com/in",
        label: null,
        status: "paused",
        createdAt: new Date(),
        lastValidatedAt: new Date(),
      }).success,
    ).toBe(false);
  });
});
