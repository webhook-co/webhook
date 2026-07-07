import { endpointPrefix, MAX_INLINE_BODY_BYTES } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import {
  readBoundedBodiesCore,
  type PayloadEventRow,
  type PayloadReaderDeps,
} from "../src/payload-reader";

// The bounded-inline-body core for triggers.wait (S5 Slice C2). Everything security-load-bearing — the RLS
// lookup scoping, the readPayloadKey org/endpoint fence on the STORED key, the size-cap clamp, the per-event
// failure isolation, and the 0-byte short-circuit — is provable here with injected deps (no workerd/R2/DB),
// exactly like guardedDeliver's SSRF guard.

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";
const EVENT = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64); // a well-formed 64-char sha256-hex object name

/** A well-formed STORED key under (org, endpoint). */
const key = (org: string, ep: string): string => `${endpointPrefix(org, ep)}${SHA}`;

const row = (over: Partial<PayloadEventRow> = {}): PayloadEventRow => ({
  id: EVENT,
  endpoint_id: ENDPOINT,
  payload_r2_key: key(ORG_A, ENDPOINT),
  payload_bytes: 17,
  content_type: "application/json",
  ...over,
});

function deps(over: Partial<PayloadReaderDeps> = {}): PayloadReaderDeps & {
  lookupMock: ReturnType<typeof vi.fn>;
  readMock: ReturnType<typeof vi.fn>;
} {
  const lookupMock = vi.fn(async () => [row()] as readonly PayloadEventRow[]);
  const readMock = vi.fn(async () => new TextEncoder().encode('{"hello":"world"}'));
  return {
    lookupEvents: lookupMock as unknown as PayloadReaderDeps["lookupEvents"],
    readObject: readMock as unknown as PayloadReaderDeps["readObject"],
    ...over,
    lookupMock,
    readMock,
  };
}

describe("readBoundedBodiesCore — tenant isolation + bounded read", () => {
  it("returns [] for an empty id list WITHOUT touching the DB or R2", async () => {
    const d = deps();
    const out = await readBoundedBodiesCore(d, { orgId: ORG_A, eventIds: [], maxBytesEach: 1024 });
    expect(out).toEqual([]);
    expect(d.lookupMock).not.toHaveBeenCalled();
    expect(d.readMock).not.toHaveBeenCalled();
  });

  it("passes the caller's orgId + ids straight to the RLS lookup (never a client-supplied scope)", async () => {
    const d = deps();
    await readBoundedBodiesCore(d, { orgId: ORG_A, eventIds: [EVENT], maxBytesEach: 1024 });
    expect(d.lookupMock).toHaveBeenCalledWith(ORG_A, [EVENT]);
  });

  it("attaches a found event's UTF-8 body verbatim", async () => {
    const d = deps();
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 1024,
    });
    expect(ev).toMatchObject({
      eventId: EVENT,
      found: true,
      body: '{"hello":"world"}',
      encoding: "utf8",
      truncated: false,
      contentType: "application/json",
    });
  });

  it("cross-org / unknown id (absent from the RLS lookup) → found:false, R2 NEVER read (no oracle)", async () => {
    // The lookup runs under ORG_B's RLS; ORG_A's event is simply not returned.
    const d = deps({ lookupEvents: async () => [] });
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_B,
      eventIds: [EVENT],
      maxBytesEach: 1024,
    });
    expect(ev).toMatchObject({ eventId: EVENT, found: false, body: null });
    expect(d.readMock).not.toHaveBeenCalled();
  });

  it("poisoned payload_r2_key (points at another org's prefix) → found:false, R2 NEVER read", async () => {
    // Same-org row, but its stored key is fenced to a DIFFERENT org/endpoint → readPayloadKey rejects it.
    const d = deps({
      lookupEvents: async () => [row({ payload_r2_key: key(ORG_B, ENDPOINT) })],
    });
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 1024,
    });
    expect(ev.found).toBe(false);
    expect(ev.body).toBeNull();
    expect(d.readMock).not.toHaveBeenCalled();
  });

  it("honors maxBytesEach and marks truncated when the stored body is larger", async () => {
    const clipped = new Uint8Array(128).fill(0x61); // 128 'a' bytes returned
    const readSpy = vi.fn(async () => clipped);
    const d = deps({
      lookupEvents: async () => [row({ payload_bytes: 10_240 })], // 10 KiB stored
      readObject: readSpy as unknown as PayloadReaderDeps["readObject"],
    });
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 128,
    });
    expect(readSpy).toHaveBeenCalledWith(key(ORG_A, ENDPOINT), 128);
    expect(ev).toMatchObject({ found: true, truncated: true, byteLength: 128, encoding: "utf8" });
  });

  it("clamps maxBytesEach to the server cap (MAX_INLINE_BODY_BYTES)", async () => {
    const d = deps();
    await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 999_999,
    });
    expect(d.readMock).toHaveBeenCalledWith(key(ORG_A, ENDPOINT), MAX_INLINE_BODY_BYTES);
  });

  it("clamps a non-positive maxBytesEach up to at least 1 byte", async () => {
    const d = deps();
    await readBoundedBodiesCore(d, { orgId: ORG_A, eventIds: [EVENT], maxBytesEach: 0 });
    expect(d.readMock).toHaveBeenCalledWith(key(ORG_A, ENDPOINT), 1);
  });

  it("0-byte body short-circuits to an explicit empty body, NEVER issuing the doomed range read", async () => {
    const d = deps({ lookupEvents: async () => [row({ payload_bytes: 0 })] });
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 1024,
    });
    expect(ev).toMatchObject({ found: true, body: "", byteLength: 0, truncated: false });
    expect(d.readMock).not.toHaveBeenCalled();
  });

  it("R2 returning null (object gone) → found:false", async () => {
    const d = deps({ readObject: async () => null });
    const [ev] = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT],
      maxBytesEach: 1024,
    });
    expect(ev).toMatchObject({ found: false, body: null });
  });

  it("a per-event R2 failure isolates to THAT event — the page still resolves", async () => {
    const EVENT2 = "55555555-5555-4555-8555-555555555555";
    const ENDPOINT2 = "77777777-7777-4777-8777-777777777777";
    const good = new TextEncoder().encode("ok");
    const d = deps({
      lookupEvents: async () => [
        row(),
        row({ id: EVENT2, endpoint_id: ENDPOINT2, payload_r2_key: key(ORG_A, ENDPOINT2) }),
      ],
      // Deterministic by key (order-independent under Promise.all): EVENT's read throws, EVENT2's succeeds.
      readObject: async (k: string) => {
        if (k === key(ORG_A, ENDPOINT)) throw new Error("transient R2 error");
        return good;
      },
    });
    const out = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [EVENT, EVENT2],
      maxBytesEach: 1024,
    });
    // Order + arity mirror eventIds. Exactly the failing event degraded; the page never rejected.
    expect(out.map((e) => e.eventId)).toEqual([EVENT, EVENT2]);
    expect(out[0]).toMatchObject({ eventId: EVENT, found: false, body: null });
    expect(out[1]).toMatchObject({ eventId: EVENT2, found: true, body: "ok" });
  });

  it("preserves eventIds order + arity even with a mixed found/not-found page", async () => {
    const MISSING = "66666666-6666-4666-8666-666666666666";
    const d = deps({ lookupEvents: async () => [row()] }); // only EVENT resolves; MISSING absent
    const out = await readBoundedBodiesCore(d, {
      orgId: ORG_A,
      eventIds: [MISSING, EVENT],
      maxBytesEach: 1024,
    });
    expect(out.map((e) => e.eventId)).toEqual([MISSING, EVENT]);
    expect(out[0]!.found).toBe(false);
    expect(out[1]!.found).toBe(true);
  });
});
