import { describe, expect, it } from "vitest";

import { deriveDedup } from "../src/dedup";

const BUCKET_WIDTH_MS = 24 * 60 * 60 * 1000; // 24h
const NOW = new Date("2026-06-14T12:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}

describe("deriveDedup — first-match strategy (sw_webhook_id -> provider_event_id -> content_hash)", () => {
  it("uses the Standard-Webhooks `webhook-id` header when present", async () => {
    const body = enc(`{"hello":"world"}`);
    const d = await deriveDedup(body, [["webhook-id", "msg_2abc"]], NOW, BUCKET_WIDTH_MS);
    expect(d.dedupStrategy).toBe("sw_webhook_id");
    expect(d.dedupKey).toBe("msg_2abc");
    expect(d.dedupBucket).toBeNull();
    expect(hex(d.contentHash)).toBe(await sha256hex(body)); // hash always computed
  });

  it("uses the Stripe event id (parsed body $.id), namespaced", async () => {
    const body = enc(`{"id":"evt_123","type":"charge.succeeded"}`);
    const d = await deriveDedup(
      body,
      [["stripe-signature", "t=1,v1=deadbeef"]],
      NOW,
      BUCKET_WIDTH_MS,
    );
    expect(d.dedupStrategy).toBe("provider_event_id");
    expect(d.provider).toBe("stripe");
    expect(d.providerEventId).toBe("evt_123");
    expect(d.dedupKey).toBe("stripe:evt_123");
  });

  it("uses the GitHub delivery guid from the X-GitHub-Delivery header", async () => {
    const body = enc(`{"action":"opened"}`);
    const d = await deriveDedup(
      body,
      [
        ["x-hub-signature-256", "sha256=abc"],
        ["x-github-delivery", "72d3162e-cc78"],
      ],
      NOW,
      BUCKET_WIDTH_MS,
    );
    expect(d.dedupStrategy).toBe("provider_event_id");
    expect(d.provider).toBe("github");
    expect(d.dedupKey).toBe("github:72d3162e-cc78");
  });

  it("falls back to content_hash + a time bucket when no id is available", async () => {
    const body = enc(`anything without a recognized id`);
    const d = await deriveDedup(body, [], NOW, BUCKET_WIDTH_MS);
    expect(d.dedupStrategy).toBe("content_hash");
    const hex = await sha256hex(body);
    const bucket = Math.floor(NOW.getTime() / BUCKET_WIDTH_MS);
    expect(d.dedupBucket).toBe(bucket);
    expect(d.dedupKey).toBe(`${hex}:${bucket}`); // bucket folded into the key so same body in a later bucket is distinct
  });

  it("falls through to content_hash when the provider body can't be parsed for an id", async () => {
    const body = enc(`not json`);
    const d = await deriveDedup(body, [["stripe-signature", "t=1,v1=x"]], NOW, BUCKET_WIDTH_MS);
    expect(d.dedupStrategy).toBe("content_hash"); // stripe detected, but no parseable $.id
    expect(d.provider).toBe("stripe"); // provider still recorded for inspection
  });

  it("NEVER mutates the raw body bytes (verification owns them)", async () => {
    const original = enc(`{"id":"evt_keep","x":1}`);
    const snapshot = original.slice();
    await deriveDedup(original, [["stripe-signature", "t=1,v1=x"]], NOW, BUCKET_WIDTH_MS);
    expect(Array.from(original)).toEqual(Array.from(snapshot));
  });
});
