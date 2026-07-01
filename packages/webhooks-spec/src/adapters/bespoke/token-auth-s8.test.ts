import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// S8 coverage — more Tier-4 NON-CRYPTOGRAPHIC authenticity providers, each a thin config over the shared
// token-auth factory (a match is the weaker "authenticated" status, not cryptographic "verified"):
//   fixed-header token : telegram (`X-Telegram-Bot-Api-Secret-Token`)
//   HTTP Basic auth    : mixpanel
//   operator-configured header (secret = JSON {header, token}) : new_relic, fillout, zapier
// (Doc-verified 2026-07-01.) Providers the research found to actually sign — Tally/Miro/Customer.io/
// Framer (HMAC), Loops (Standard Webhooks), Google Chat (asymmetric) — belong in the crypto tiers, not here.
// All tokens/credentials below are fabricated for the unit test — not live secrets.

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode("{}"),
    headers: [] as [string, string][],
    secrets: [] as string[],
    method: "POST",
    requestUrl: "https://wbhk.my/whep_tok",
    ...overrides,
  };
}

describe("telegram — fixed-header token", () => {
  const adapter = getAdapterForScheme("telegram")!;
  const TOKEN = "tg-webhook-secret-token-123"; // gitleaks:allow — fake test fixture

  it("exposes the x-telegram-bot-api-secret-token header", () => {
    expect(adapter.scheme).toBe("telegram");
    expect(adapter.signatureHeader).toBe("x-telegram-bot-api-secret-token");
  });

  it("authenticates a matching X-Telegram-Bot-Api-Secret-Token as token", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-telegram-bot-api-secret-token", TOKEN]], secrets: [TOKEN] }),
    );
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "telegram",
      authenticity: "token",
    });
  });

  it("rejects a wrong token with SIGNATURE_MISMATCH", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-telegram-bot-api-secret-token", "wrong"]], secrets: [TOKEN] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("reports MISSING_HEADER when the header is absent", async () => {
    const result = await adapter.verify(input({ headers: [], secrets: [TOKEN] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});

describe("mixpanel — HTTP Basic auth", () => {
  const adapter = getAdapterForScheme("mixpanel")!;
  const USERPASS = "mp-user:mp-pass"; // gitleaks:allow — fake test fixture

  it("exposes the authorization header", () => {
    expect(adapter.scheme).toBe("mixpanel");
    expect(adapter.signatureHeader).toBe("authorization");
  });

  it("authenticates a matching Basic credential as basic", async () => {
    const result = await adapter.verify(
      input({ headers: [["authorization", `Basic ${btoa(USERPASS)}`]], secrets: [USERPASS] }),
    );
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "mixpanel",
      authenticity: "basic",
    });
  });

  it("rejects a wrong Basic credential", async () => {
    const result = await adapter.verify(
      input({ headers: [["authorization", `Basic ${btoa("bad:creds")}`]], secrets: [USERPASS] }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("operator-configured header providers (new_relic / fillout / zapier)", () => {
  for (const slug of ["new_relic", "fillout", "zapier"] as const) {
    describe(slug, () => {
      const adapter = getAdapterForScheme(slug)!;
      // The registered secret is a JSON {header, token}; the operator chose both.
      const SECRET = JSON.stringify({ header: "x-webhook-token", token: "cfg-tok-abc" }); // gitleaks:allow — fake test fixture

      it("has no fixed signature header (operator-configured)", () => {
        expect(adapter.scheme).toBe(slug);
        expect(adapter.signatureHeader).toBe("");
      });

      it("authenticates a matching configured header as token", async () => {
        const result = await adapter.verify(
          input({ headers: [["x-webhook-token", "cfg-tok-abc"]], secrets: [SECRET] }),
        );
        expect(result).toEqual({
          ok: true,
          keyId: "secret_0",
          scheme: slug,
          authenticity: "token",
        });
      });

      it("rejects a wrong configured-header value", async () => {
        const result = await adapter.verify(
          input({ headers: [["x-webhook-token", "wrong"]], secrets: [SECRET] }),
        );
        expect(result.ok).toBe(false);
      });
    });
  }
});
