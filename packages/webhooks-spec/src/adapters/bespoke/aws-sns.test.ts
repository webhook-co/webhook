import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Amazon SNS — RSA over a `Key\nValue\n` canonical of the body fields; cert fetched from SigningCertURL.
// No private key in the repo: a runtime keypair (hash per SignatureVersion) wrapped in a minimal X.509 cert.

const TOPIC = "arn:aws:sns:us-east-1:123456789012:my-topic";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function derLen(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag, ...derLen(content.length)]), content);
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));

async function setup(hash: "SHA-1" | "SHA-256"): Promise<{
  certPem: string;
  sign: (message: string) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const tbs = seq(tlv(0x02, new Uint8Array([1])), seq(), seq(), seq(), seq(), spkiDer);
  const certDer = seq(tbs, seq(), tlv(0x03, new Uint8Array([0x00])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64(certDer)}\n-----END CERTIFICATE-----`;
  const sign = async (message: string): Promise<string> =>
    b64(
      new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, utf8Encoder.encode(message)),
      ),
    );
  return { certPem, sign };
}

/** A signed SNS message: build the canonical, sign it, embed the Signature, return the rawBody JSON. */
async function signedMessage(
  fields: Record<string, string>,
  keys: string[],
  signatureVersion: string,
  sign: (m: string) => Promise<string>,
): Promise<Uint8Array> {
  const canonical = keys
    .map((k) => (fields[k] !== undefined ? `${k}\n${fields[k]}\n` : ""))
    .join("");
  const signature = await sign(canonical);
  return utf8Encoder.encode(
    JSON.stringify({
      ...fields,
      SignatureVersion: signatureVersion,
      Signature: signature,
      SigningCertURL: CERT_URL,
    }),
  );
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CONFIRMATION_KEYS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

const notification = {
  Type: "Notification",
  MessageId: "msg-1",
  TopicArn: TOPIC,
  Message: "hello from SES",
  Timestamp: "2026-06-30T20:00:00.000Z",
};

describe("aws_sns bespoke (RSA over Key\\nValue\\n canonical, cert-URL)", () => {
  it("exposes aws_sns metadata (empty signature header — sig is in the body)", () => {
    const adapter = getAdapterForScheme("aws_sns")!;
    expect(adapter.scheme).toBe("aws_sns");
    expect(adapter.signatureHeader).toBe("");
  });

  it("verifies a SignatureVersion 2 (SHA-256) Notification", async () => {
    const { certPem, sign } = await setup("SHA-256");
    const rawBody = await signedMessage(notification, NOTIFICATION_KEYS, "2", sign);
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "aws_sns" });
  });

  it("verifies a SignatureVersion 1 (SHA-1) Notification", async () => {
    const { certPem, sign } = await setup("SHA-1");
    const rawBody = await signedMessage(notification, NOTIFICATION_KEYS, "1", sign);
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(true);
  });

  it("verifies a SubscriptionConfirmation (surface-only: signature verified, no auto-confirm)", async () => {
    const { certPem, sign } = await setup("SHA-256");
    const confirm = {
      Type: "SubscriptionConfirmation",
      MessageId: "msg-2",
      TopicArn: TOPIC,
      Message: "confirm me",
      Timestamp: "2026-06-30T20:00:00.000Z",
      Token: "tok-123",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok-123",
    };
    let fetched = false;
    const rawBody = await signedMessage(confirm, CONFIRMATION_KEYS, "2", sign);
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => {
        fetched = true;
        return utf8Encoder.encode(certPem);
      },
    });
    expect(result.ok).toBe(true); // verified
    expect(fetched).toBe(true); // only the CERT was fetched — the SubscribeURL is never auto-GET'd here
  });

  it("reports NO_MATCHING_KEY when the TopicArn isn't a registered secret", async () => {
    const { certPem, sign } = await setup("SHA-256");
    const rawBody = await signedMessage(notification, NOTIFICATION_KEYS, "2", sign);
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: ["arn:aws:sns:us-east-1:000000000000:other"],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("rejects a tampered Message as SIGNATURE_MISMATCH", async () => {
    const { certPem, sign } = await setup("SHA-256");
    const rawBody = await signedMessage(notification, NOTIFICATION_KEYS, "2", sign);
    const tampered = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
    tampered.Message = "MALICIOUS";
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody: utf8Encoder.encode(JSON.stringify(tampered)),
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an untrusted SigningCertURL host as SIGNATURE_MISMATCH", async () => {
    const { certPem, sign } = await setup("SHA-256");
    const canonical = NOTIFICATION_KEYS.map((k) =>
      notification[k as keyof typeof notification]
        ? `${k}\n${notification[k as keyof typeof notification]}\n`
        : "",
    ).join("");
    const signature = await sign(canonical);
    const rawBody = utf8Encoder.encode(
      JSON.stringify({
        ...notification,
        SignatureVersion: "2",
        Signature: signature,
        SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.com/x.pem", // lookalike host
      }),
    );
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("fails soft to KEY_FETCH_FAILED when the cert can't be fetched", async () => {
    const { sign } = await setup("SHA-256");
    const rawBody = await signedMessage(notification, NOTIFICATION_KEYS, "2", sign);
    const result = await getAdapterForScheme("aws_sns")!.verify({
      rawBody,
      headers: [],
      secrets: [TOPIC],
      fetchKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });
});
