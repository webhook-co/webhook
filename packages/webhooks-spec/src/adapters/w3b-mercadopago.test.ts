import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W3b — Mercado Pago. Header `x-signature: ts=<ts>,v1=<hex>` (+ `x-request-id`). The signed "manifest"
// is `id:<lower(data.id)>;request-id:<x-request-id>;ts:<ts>;` where `data.id` is the URL query param
// (LOWERCASED unconditionally — load-bearing for alphanumeric ORDER/Point ids) and an ABSENT segment is
// removed entirely. HMAC-SHA256/hex, key = the dashboard secret as utf8 (not hex-decoded), no window.
// Self-consistent KATs (no published vector); the lowercase is proven load-bearing by signing the
// lowercased id while the URL carries the upper-case one.

const SECRET = "mp-webhook-secret-0123456789abcdef";
const TS = "1742505638683"; // 13-digit ms (MP units vary by product; spliced verbatim)
const REQ_ID = "req-abc-123";

async function v1(manifest: string): Promise<string> {
  return bytesToHex(await hmacSha256(utf8Encoder.encode(SECRET), utf8Encoder.encode(manifest)));
}

describe("W3b mercado_pago (manifest: lowercased data.id + conditional segments)", () => {
  it("exposes x-signature metadata", () => {
    const a = getAdapterForScheme("mercado_pago")!;
    expect(a.scheme).toBe("mercado_pago");
    expect(a.signatureHeader).toBe("x-signature");
  });

  it("verifies a full manifest, lowercasing an alphanumeric data.id", async () => {
    const dataId = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3"; // upper-case in the URL
    const manifest = `id:${dataId.toLowerCase()};request-id:${REQ_ID};ts:${TS};`;
    const sig = await v1(manifest);
    const result = await getAdapterForScheme("mercado_pago")!.verify({
      rawBody: utf8Encoder.encode("{}"),
      headers: [
        ["x-signature", `ts=${TS},v1=${sig}`],
        ["x-request-id", REQ_ID],
      ],
      secrets: [SECRET],
      requestUrl: `https://wbhk.my/whep_abc?data.id=${dataId}&type=order`,
      method: "POST",
      now: new Date(Number(TS) + 1000),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "mercado_pago" });
  });

  it("omits the whole id segment when data.id is absent from the query", async () => {
    // No data.id in the URL → manifest drops the `id:...;` segment entirely.
    const manifest = `request-id:${REQ_ID};ts:${TS};`;
    const sig = await v1(manifest);
    const result = await getAdapterForScheme("mercado_pago")!.verify({
      rawBody: utf8Encoder.encode("{}"),
      headers: [
        ["x-signature", `ts=${TS},v1=${sig}`],
        ["x-request-id", REQ_ID],
      ],
      secrets: [SECRET],
      requestUrl: `https://wbhk.my/whep_abc?type=payment`,
      method: "POST",
      now: new Date(Number(TS) + 1000),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "mercado_pago" });
  });

  it("rejects when the id is NOT lowercased (proves the transform is load-bearing)", async () => {
    const dataId = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3";
    // Sign with the UPPER-case id (wrong) — the adapter lowercases, so this must NOT match.
    const wrong = `id:${dataId};request-id:${REQ_ID};ts:${TS};`;
    const sig = await v1(wrong);
    const result = await getAdapterForScheme("mercado_pago")!.verify({
      rawBody: utf8Encoder.encode("{}"),
      headers: [
        ["x-signature", `ts=${TS},v1=${sig}`],
        ["x-request-id", REQ_ID],
      ],
      secrets: [SECRET],
      requestUrl: `https://wbhk.my/whep_abc?data.id=${dataId}&type=order`,
      method: "POST",
      now: new Date(Number(TS) + 1000),
    });
    expect(result.ok).toBe(false);
  });
});
