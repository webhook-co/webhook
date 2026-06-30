import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Wise — RSASSA-PKCS1-v1_5/SHA-256 over the RAW body, base64 sig in `X-Signature-SHA256`, the registered
// key is Wise's published PEM public key. End-to-end through the registry on Wise's PUBLIC gold vector
// (sandbox key); the crypto is also covered by asymmetric.test.ts.

const SIG_HEADER = "x-signature-sha256";
const BODY =
  '{"data":{"resource":{"id":49983981,"profile_id":16055450,"account_id":14124090,"type":"transfer"},"current_state":"incoming_payment_waiting","previous_state":null,"occurred_at":"2021-08-23T10:12:50Z"},"subscription_id":"90aa8e14-4ef1-4a56-861c-f3c9cde097ea","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2021-08-23T10:12:50Z"}';
const SIG =
  "wKcKCYXAzxNgiu7xmoDm943NUni7Rz33QN8JkEA9dWSGebgndonabgSj18Y4C08OrwVmueGsED2s00M7DtJVcYKOS1i3G4TMVx+mgM3aL9djMBkQtiYNBFUd6wrPI7ZUNHv/TrlKSjTMc+6JFvUvJ7owY3z85e3I4jLRLJowMFvO8kvCJ60+1pY9wDwZvtZ//WS93LrwGjk9Dvwzpmu0w+P4J75tETT5qC3Uv0y5G2yO8SEoO3yNP/tg/BOli02niHb53vEOUWUb9bly6thnfMoXoiV/osoGxgF20R58RlvkAmezyyl1Sv542TfS2DpiwVnmjjjkCyXeSUcKookYLQ=="; // gitleaks:allow
const PEM = [
  "-----BEGIN PUBLIC KEY-----", // gitleaks:allow (Wise's PUBLIC sandbox key)
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP",
  "ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU",
  "ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j",
  "wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg",
  "nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg",
  "z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs",
  "VwIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");
const NOW = new Date(1629713570 * 1000);

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(BODY),
    headers: [[SIG_HEADER, SIG]] as [string, string][],
    secrets: [PEM],
    now: NOW,
    ...overrides,
  };
}

describe("wise bespoke (RSA-PKCS1 SHA-256 over the raw body, PEM key)", () => {
  it("exposes wise metadata", () => {
    const adapter = getAdapterForScheme("wise")!;
    expect(adapter.scheme).toBe("wise");
    expect(adapter.signatureHeader).toBe(SIG_HEADER);
  });

  it("verifies the gold vector (PEM key, base64 sig over the raw body)", async () => {
    expect(await getAdapterForScheme("wise")!.verify(input())).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "wise",
    });
  });

  it("rejects a tampered body as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("wise")!.verify(
      input({ rawBody: utf8Encoder.encode(`${BODY} `) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when the signature header is absent", async () => {
    const result = await getAdapterForScheme("wise")!.verify(input({ headers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("reports NO_MATCHING_KEY when no usable public key is registered", async () => {
    const result = await getAdapterForScheme("wise")!.verify(input({ secrets: ["not-a-key"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });
});
