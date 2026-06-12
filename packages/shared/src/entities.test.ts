import { describe, expect, it } from "vitest";

import {
  DeliveryAttemptSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  OrgSchema,
} from "./entities";

const uuid = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

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
});
