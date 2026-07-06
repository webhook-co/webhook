import { describe, expect, it } from "vitest";

import { deriveDedup, type DedupParams } from "../src/dedup";

const BUCKET_WIDTH_MS = 24 * 60 * 60 * 1000; // 24h
const NOW = new Date("2026-06-14T12:00:00Z");
const EVENT_ID = "0192abcd-event-id"; // a pre-minted uuidv7 (off/fail-safe key material)
const U = (s = "https://wbhk.my/whep_tok") => new URL(s);
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const IDENT: DedupParams = { mode: "identifier", windowMs: BUCKET_WIDTH_MS };
const CONTENT: DedupParams = { mode: "content", windowMs: BUCKET_WIDTH_MS };
const OFF: DedupParams = { mode: "off" };
const fields = (include: string[], exclude: string[] = []): DedupParams => ({
  mode: "fields",
  windowMs: BUCKET_WIDTH_MS,
  include,
  exclude,
});

async function sha256hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}

describe("deriveDedup — identifier mode (default ladder: sw_webhook_id -> provider_event_id -> content_hash)", () => {
  it("uses the Standard-Webhooks `webhook-id` header when present", async () => {
    const body = enc(`{"hello":"world"}`);
    const d = await deriveDedup(
      body,
      [["webhook-id", "msg_2abc"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(d.dedupStrategy).toBe("sw_webhook_id");
    expect(d.dedupKey).toBe("msg_2abc"); // id-based strategy is verb- and URL-independent
    expect(d.dedupBucket).toBeNull();
    expect(hex(d.contentHash)).toBe(await sha256hex(body)); // hash always computed
  });

  it("uses the Stripe event id (parsed body $.id), namespaced", async () => {
    const body = enc(`{"id":"evt_123","type":"charge.succeeded"}`);
    const d = await deriveDedup(
      body,
      [["stripe-signature", "t=1,v1=deadbeef"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(d.dedupStrategy).toBe("provider_event_id");
    expect(d.provider).toBe("stripe");
    expect(d.dedupKey).toBe("stripe:evt_123");
  });

  it("uses the GitHub delivery guid from the X-GitHub-Delivery header", async () => {
    const d = await deriveDedup(
      enc(`{"action":"opened"}`),
      [
        ["x-hub-signature-256", "sha256=abc"],
        ["x-github-delivery", "72d3162e-cc78"],
      ],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(d.dedupStrategy).toBe("provider_event_id");
    expect(d.dedupKey).toBe("github:72d3162e-cc78");
  });

  it("id-based strategies are URL-independent (a provider retries the same event to the same endpoint)", async () => {
    const body = enc(`{"id":"evt_1"}`);
    const a = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U("https://wbhk.my/t?a=1"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const b = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U("https://wbhk.my/t?a=2"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  it("falls back to content_hash + method + canonical target + a time bucket when no id is available", async () => {
    const body = enc(`anything without a recognized id`);
    const d = await deriveDedup(body, [], "POST", U(), EVENT_ID, NOW, IDENT);
    expect(d.dedupStrategy).toBe("content_hash");
    const h = await sha256hex(body);
    const bucket = Math.floor(NOW.getTime() / BUCKET_WIDTH_MS);
    expect(d.dedupBucket).toBe(bucket);
    expect(d.dedupKey).toBe(`POST:${h}:/whep_tok:${bucket}`);
    expect(d.provider).toBeNull();
  });

  it("content_hash is METHOD-SCOPED: different verbs collapse-safe; same verb collapses", async () => {
    const body = enc(``);
    const get1 = await deriveDedup(body, [], "GET", U(), EVENT_ID, NOW, IDENT);
    const get2 = await deriveDedup(body, [], "GET", U(), EVENT_ID, NOW, IDENT);
    const post = await deriveDedup(body, [], "POST", U(), EVENT_ID, NOW, IDENT);
    expect(get1.dedupKey).toBe(get2.dedupKey);
    expect(get1.dedupKey).not.toBe(post.dedupKey);
  });

  it("a Standard-Webhooks sender WITHOUT a webhook-id falls through to content_hash but records the provider", async () => {
    const d = await deriveDedup(
      enc(`{"data":1}`),
      [
        ["webhook-signature", "v1,abc"],
        ["webhook-timestamp", "1718366400"],
      ],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(d.dedupStrategy).toBe("content_hash");
    expect(d.provider).toBe("standard_webhooks");
    expect(d.dedupBucket).not.toBeNull();
  });

  it("falls through to content_hash when the provider body can't be parsed for an id", async () => {
    const d = await deriveDedup(
      enc(`not json`),
      [["stripe-signature", "t=1,v1=x"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(d.dedupStrategy).toBe("content_hash");
    expect(d.provider).toBe("stripe");
  });

  it("NEVER mutates the raw body bytes (verification owns them)", async () => {
    const original = enc(`{"id":"evt_keep","x":1}`);
    const snapshot = original.slice();
    await deriveDedup(
      original,
      [["stripe-signature", "t=1,v1=x"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(Array.from(original)).toEqual(Array.from(snapshot));
  });
});

describe("deriveDedup — canonical path+query fold (the query-blindness fix)", () => {
  it("distinguishes requests that differ only by query value (the founder's 3-GETs case)", async () => {
    const body = enc(``);
    const none = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/whep_tok"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const a = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/whep_tok?name=Sourabh"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const b = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/whep_tok?name=Sourabh1"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(new Set([none.dedupKey, a.dedupKey, b.dedupKey]).size).toBe(3);
  });

  it("is order- and encoding-insensitive (canonicalized)", async () => {
    const body = enc(``);
    const ab = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?a=1&b=2"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const ba = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?b=2&a=1"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(ab.dedupKey).toBe(ba.dedupKey);
    const spaceEnc = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?q=a%20b"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const spacePlus = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?q=a+b"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(spaceEnc.dedupKey).toBe(spacePlus.dedupKey);
  });

  it("ignores volatile params (tracking / cache-busting / per-attempt) so retries still collapse", async () => {
    const body = enc(``);
    const clean = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?id=1"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const noisy = await deriveDedup(
      body,
      [],
      "GET",
      U("https://wbhk.my/t?id=1&utm_source=x&cachebust=99&attempt=3"),
      EVENT_ID,
      NOW,
      IDENT,
    );
    expect(clean.dedupKey).toBe(noisy.dedupKey);
  });

  it("collapses identical repeated requests (same method, target, body, bucket)", async () => {
    const body = enc(``);
    const a = await deriveDedup(body, [], "GET", U("https://wbhk.my/t?x=1"), EVENT_ID, NOW, IDENT);
    const b = await deriveDedup(body, [], "GET", U("https://wbhk.my/t?x=1"), EVENT_ID, NOW, IDENT);
    expect(a.dedupKey).toBe(b.dedupKey);
  });
});

describe("deriveDedup — content mode", () => {
  it("skips the id ladder and always keys on the canonical content hash", async () => {
    // A stripe body WITH an id: identifier mode would use `stripe:evt_x`; content mode ignores it.
    const body = enc(`{"id":"evt_x"}`);
    const ident = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      IDENT,
    );
    const content = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      CONTENT,
    );
    expect(ident.dedupStrategy).toBe("provider_event_id");
    expect(content.dedupStrategy).toBe("content_hash");
    expect(content.dedupKey).not.toBe(ident.dedupKey);
  });
});

describe("deriveDedup — off mode", () => {
  it("produces a per-request unique key (every request is a distinct event)", async () => {
    const body = enc(`{"id":"evt_x"}`);
    const a = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U(),
      "event-a",
      NOW,
      OFF,
    );
    const b = await deriveDedup(
      body,
      [["stripe-signature", "x"]],
      "POST",
      U(),
      "event-b",
      NOW,
      OFF,
    );
    expect(a.dedupStrategy).toBe("unique");
    expect(a.dedupKey).toBe("unique:event-a");
    expect(b.dedupKey).toBe("unique:event-b");
    expect(a.dedupKey).not.toBe(b.dedupKey);
    expect(a.dedupBucket).toBeNull();
  });
});

describe("deriveDedup — fields mode", () => {
  it("keys on a configured body scalar, stable across surrounding noise", async () => {
    const a = await deriveDedup(
      enc(`{"id":"k1","ts":1}`),
      [],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      fields(["body.id"]),
    );
    const b = await deriveDedup(
      enc(`{"ts":9,"id":"k1"}`),
      [],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      fields(["body.id"]),
    );
    const c = await deriveDedup(
      enc(`{"id":"k2"}`),
      [],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      fields(["body.id"]),
    );
    expect(a.dedupStrategy).toBe("fields");
    expect(a.dedupKey).toBe(b.dedupKey); // same selected value collapses
    expect(a.dedupKey).not.toBe(c.dedupKey); // different value is distinct
  });

  it("FAIL-SAFE: a missing configured field yields a unique key (never over-collapse)", async () => {
    const d = await deriveDedup(
      enc(`{"other":1}`),
      [],
      "POST",
      U(),
      EVENT_ID,
      NOW,
      fields(["body.id"]),
    );
    expect(d.dedupStrategy).toBe("unique");
    expect(d.dedupKey).toBe(`unique:${EVENT_ID}`);
  });

  it("degrades to content_hash for an over-large body", async () => {
    const big = enc(`{"id":"` + "a".repeat(70_000) + `"}`);
    const d = await deriveDedup(big, [], "POST", U(), EVENT_ID, NOW, fields(["body.id"]));
    expect(d.dedupStrategy).toBe("content_hash");
  });
});
