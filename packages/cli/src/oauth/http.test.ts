import { describe, expect, it } from "vitest";

import { postForm, readOAuthError } from "./http.js";

const jsonRes = (body: unknown, status = 400): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("postForm", () => {
  it("POSTs a form-urlencoded body and asks for JSON back", async () => {
    let captured: { url: string; init?: RequestInit } = { url: "" };
    const fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await postForm({ fetch }, "https://auth.webhook.co/token", { a: "1", b: "two" });
    expect(captured.url).toBe("https://auth.webhook.co/token");
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(captured.init?.body)).toBe("a=1&b=two");
  });
});

describe("readOAuthError", () => {
  it("extracts the error code and description from an issuer error body", async () => {
    expect(
      await readOAuthError(jsonRes({ error: "invalid_grant", error_description: "expired" })),
    ).toEqual({ code: "invalid_grant", detail: "expired" });
  });

  it("falls back to a synthetic http_<status> code on a non-JSON body", async () => {
    const res = new Response("<html>oops</html>", { status: 502 });
    expect(await readOAuthError(res)).toEqual({ code: "http_502" });
  });

  it("falls back to http_<status> when the JSON lacks a string `error`", async () => {
    expect(await readOAuthError(jsonRes({ nope: true }, 503))).toEqual({ code: "http_503" });
  });

  it("strips terminal-control bytes from the server-controlled error/description", async () => {
    // A hostile/compromised issuer could embed an ANSI escape; this string flows into
    // OAuthError.userMessage → stderr, which bypasses the text renderers' sanitizeControl.
    const ESC = String.fromCharCode(27);
    const out = await readOAuthError(
      jsonRes({ error: `evil${ESC}[2K`, error_description: `det${ESC}[31mail` }),
    );
    expect(out.code).not.toContain(ESC);
    expect(out.detail).not.toContain(ESC);
    expect(out.code).toContain("evil"); // printable text survives
    expect(out.detail).toContain("ail");
  });
});
