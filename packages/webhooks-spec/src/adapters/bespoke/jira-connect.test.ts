import { describe, expect, it } from "vitest";

import { importHmacKeyForHash, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";
import { jiraCanonicalRequest, jiraQsh } from "./jira-connect";

// Jira / Atlassian Connect — `Authorization: JWT <token>`, HS256 over the install sharedSecret (verbatim
// utf8), request bound by the `qsh` (query-string-hash) claim. The qsh canonicalization is the fiddly part,
// so it's validated DIRECTLY against Atlassian's PUBLISHED gold values:
//   - the Bitbucket "Query string hash" doc publishes a canonical request AND its hash (authoritative).
//   - the Jira "Understanding JWT" doc publishes the canonical STRING for a repeated/space/sort example.
// Both confirm: RFC3986 encoding, sort-by-name, repeated values joined by a LITERAL comma (the doc prose
// saying %2C is wrong), space → %20.

describe("jira qsh canonicalization (Atlassian published gold values)", () => {
  it("matches the Bitbucket published qsh hash for GET&/test&param=value", async () => {
    const qsh = await jiraQsh("GET", "https://api.bitbucket.org/test?param=value");
    expect(qsh).toBe("be16910858a41fd19ea5c1b4e9decca9a784d1024cb00b2158defe2f29dc86dd");
  });

  it("builds the Jira published canonical string (repeated params, spaces, sort, literal comma)", () => {
    const canonical = jiraCanonicalRequest(
      "GET",
      "https://site.atlassian.net/path/to/service?zee_last=param&repeated=parameter 1&first=param&repeated=parameter 2",
    );
    expect(canonical).toBe(
      "GET&/path/to/service&first=param&repeated=parameter%201,parameter%202&zee_last=param",
    );
  });

  it("drops a jwt query param and canonicalizes an empty path to /", () => {
    expect(jiraCanonicalRequest("POST", "https://x.atlassian.net?jwt=abc&a=1")).toBe("POST&/&a=1");
  });
});

// Adapter end-to-end — mint a JWT whose qsh matches the request and verify through the registry.
const SECRET = "an-opaque-jira-connect-shared-secret";
const HEADER = "authorization";
const ENDPOINT = "https://wbhk.my/whep_jira";
const NOW = new Date(1790000000 * 1000);

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function mintHs256(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = b64url(utf8Encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(utf8Encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await importHmacKeyForHash(utf8Encoder.encode(secret), "SHA-256");
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(signingInput)),
  );
  return `${signingInput}.${b64url(mac)}`;
}
async function jiraJwt(secret: string, qsh: string): Promise<string> {
  return `JWT ${await mintHs256(secret, { iss: "clientKey-abc", iat: 1789999900, exp: 1790000200, qsh })}`;
}

function input(token: string, overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode('{"webhookEvent":"jira:issue_created"}'),
    headers: [[HEADER, token]] as [string, string][],
    secrets: [SECRET],
    requestUrl: ENDPOINT,
    method: "POST",
    now: NOW,
    ...overrides,
  };
}

describe("jira_connect bespoke adapter (Authorization: JWT, qsh-bound)", () => {
  it("exposes jira_connect metadata", () => {
    const adapter = getAdapterForScheme("jira_connect")!;
    expect(adapter.scheme).toBe("jira_connect");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies a JWT whose qsh matches the request", async () => {
    const token = await jiraJwt(SECRET, (await jiraQsh("POST", ENDPOINT))!);
    expect(await getAdapterForScheme("jira_connect")!.verify(input(token))).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "jira_connect",
    });
  });

  it("accepts a context token (qsh = 'context-qsh') without a request-hash compare", async () => {
    const token = await jiraJwt(SECRET, "context-qsh");
    const result = await getAdapterForScheme("jira_connect")!.verify(input(token));
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong sharedSecret with WRONG_SECRET", async () => {
    const token = await jiraJwt("wrong-secret", (await jiraQsh("POST", ENDPOINT))!);
    const result = await getAdapterForScheme("jira_connect")!.verify(input(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects a qsh for a different request (path mismatch) as SIGNATURE_MISMATCH", async () => {
    const token = await jiraJwt(SECRET, (await jiraQsh("POST", "https://wbhk.my/whep_other"))!);
    const result = await getAdapterForScheme("jira_connect")!.verify(input(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an expired token as TIMESTAMP_TOO_OLD", async () => {
    const token = await jiraJwt(SECRET, (await jiraQsh("POST", ENDPOINT))!);
    const result = await getAdapterForScheme("jira_connect")!.verify(
      input(token, { now: new Date(1790001000 * 1000) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("reports MISSING_HEADER when Authorization is absent", async () => {
    const result = await getAdapterForScheme("jira_connect")!.verify(input("x", { headers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
