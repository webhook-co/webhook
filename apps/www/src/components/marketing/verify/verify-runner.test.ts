// @vitest-environment node
import { createHash, createHmac, generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getRecipe } from "@webhook-co/webhooks-recipes";
import { explain, parseHeaderLines, runVerify } from "./verify-runner";

const recipe = (slug: string) => {
  const r = getRecipe(slug);
  if (!r) throw new Error(`no recipe for ${slug}`);
  return r;
};
const hmacHex = (secret: string, msg: string) =>
  createHmac("sha256", secret).update(msg).digest("hex");

describe("runVerify — real signatures through the real engine (client-side)", () => {
  it("github: a correctly-signed raw-body HMAC verifies", async () => {
    const secret = "test-secret";
    const payload = '{"action":"opened","number":1}';
    const sig = `sha256=${hmacHex(secret, payload)}`;
    const res = await runVerify(
      { provider: "github", payload, secret, signatureValue: sig, extraHeaders: "" },
      recipe("github"),
    );
    expect(res.status).toBe("verified");
  });

  it("github: the WRONG secret fails (not a false pass)", async () => {
    const payload = '{"action":"opened"}';
    const sig = `sha256=${hmacHex("real-secret", payload)}`;
    const res = await runVerify(
      {
        provider: "github",
        payload,
        secret: "wrong-secret",
        signatureValue: sig,
        extraHeaders: "",
      },
      recipe("github"),
    );
    expect(res.status).toBe("failed");
  });

  it("github: a tampered payload fails", async () => {
    const secret = "s";
    const sig = `sha256=${hmacHex(secret, "original")}`;
    const res = await runVerify(
      { provider: "github", payload: "tampered", secret, signatureValue: sig, extraHeaders: "" },
      recipe("github"),
    );
    expect(res.status).toBe("failed");
  });

  it("stripe: verifies when the verification time is near the signed timestamp", async () => {
    const secret = "whsec_test";
    const payload = '{"id":"evt_1","type":"charge.succeeded"}';
    const ts = 1_700_000_000;
    const sig = `t=${ts},v1=${hmacHex(secret, `${ts}.${payload}`)}`;
    const res = await runVerify(
      {
        provider: "stripe",
        payload,
        secret,
        signatureValue: sig,
        extraHeaders: "",
        verificationTime: new Date(ts * 1000).toISOString(),
      },
      recipe("stripe"),
    );
    expect(res.status).toBe("verified");
  });

  it("stripe: an old event trips the replay window (TIMESTAMP_TOO_OLD) at the current verification time", async () => {
    const secret = "whsec_test";
    const payload = "{}";
    const ts = 1_700_000_000; // far in the past
    const sig = `t=${ts},v1=${hmacHex(secret, `${ts}.${payload}`)}`;
    const res = await runVerify(
      { provider: "stripe", payload, secret, signatureValue: sig, extraHeaders: "" }, // no verificationTime → now
      recipe("stripe"),
    );
    expect(res.status).toBe("failed");
    expect(res.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("slack: verifies with the timestamp pasted in the extra-headers block", async () => {
    const secret = "slack-secret";
    const payload = "token=abc&team_id=T1";
    const ts = 1_700_000_050;
    const sig = `v0=${hmacHex(secret, `v0:${ts}:${payload}`)}`;
    const res = await runVerify(
      {
        provider: "slack",
        payload,
        secret,
        signatureValue: sig,
        extraHeaders: `X-Slack-Request-Timestamp: ${ts}`,
        verificationTime: new Date(ts * 1000).toISOString(),
      },
      recipe("slack"),
    );
    expect(res.status).toBe("verified");
  });

  // The two bespoke schemes that fold EXTRA request headers into the signed message. These prove the
  // claim the dropdown makes by listing them: a correctly-signed keygen/plivo request really does verify
  // from inputs the UI can collect. Both were previously unverifiable in the browser — the recipes did
  // not declare their signed headers, so the "Other signed headers" field never rendered and the required
  // `host`/`date` (keygen) and nonce (plivo) could not be entered. See the recipe `signedHeaders` fields.
  it("keygen: a correctly-signed draft-cavage request verifies from UI-collectable inputs", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubHex = Buffer.from(
      publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    ).toString("hex");
    const payload = '{"data":{"type":"license"}}';
    const host = "api.example.com";
    const date = "Mon, 21 Jul 2026 08:00:00 GMT";
    const requestUrl = "https://api.example.com/v1/hooks?x=1";
    const u = new URL(requestUrl);
    const signingString = [
      `(request-target): post ${u.pathname}${u.search}`,
      `host: ${host}`,
      `date: ${date}`,
      `digest: sha-256=${createHash("sha256").update(payload).digest("base64")}`,
    ].join("\n");
    const sig = edSign(null, Buffer.from(signingString), privateKey).toString("base64");
    const res = await runVerify(
      {
        provider: "keygen",
        payload,
        secret: pubHex,
        signatureValue: `keyid="acct_1",algorithm="ed25519",signature="${sig}",headers="(request-target) host date digest"`,
        extraHeaders: `host: ${host}\ndate: ${date}`,
        requestUrl,
        method: "POST",
      },
      recipe("keygen"),
    );
    expect(res.status).toBe("verified");
  });

  it("plivo: a correctly-signed v3 request verifies once the nonce header is supplied", async () => {
    const secret = "plivo-auth-token";
    const requestUrl = "https://example.com/plivo";
    const payload = "b=2&a=1";
    const sorted = [...new URLSearchParams(payload).entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const base = `https://example.com/plivo?${sorted.map(([k, v]) => `${k}${v}`).join("")}`;
    const nonce = "nonce-123";
    const sig = createHmac("sha256", secret).update(`${base}.${nonce}`).digest("base64");
    const res = await runVerify(
      {
        provider: "plivo",
        payload,
        secret,
        signatureValue: sig,
        extraHeaders: `X-Plivo-Signature-V3-Nonce: ${nonce}`,
        requestUrl,
        method: "POST",
      },
      recipe("plivo"),
    );
    expect(res.status).toBe("verified");
  });

  it("a remote-fetch provider (paypal) reports it can't be verified client-side", async () => {
    const res = await runVerify(
      { provider: "paypal", payload: "{}", secret: "x", signatureValue: "y", extraHeaders: "" },
      recipe("paypal"),
    );
    expect(res.status).toBe("error");
    expect(res.explanation).toMatch(/browser/i);
  });
});

describe("explain + parseHeaderLines", () => {
  it("parseHeaderLines: parses Name: value lines, skips blanks/garbage", () => {
    expect(parseHeaderLines("X-A: 1\n\nnope\nX-B:  two ")).toEqual([
      ["X-A", "1"],
      ["X-B", "two"],
    ]);
  });

  it("explain: maps a TIMESTAMP_TOO_OLD failure to a helpful message", () => {
    const r = explain({
      ok: false,
      reason: { code: "TIMESTAMP_TOO_OLD", skewSeconds: 999, toleranceSeconds: 300 },
    } as never);
    expect(r.status).toBe("failed");
    expect(r.explanation).toMatch(/verification time/i);
  });
});
