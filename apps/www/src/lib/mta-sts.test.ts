import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MTA_STS_HOST, MTA_STS_POLICY, MTA_STS_POLICY_ID, mtaStsResponse } from "./mta-sts";

describe("MTA-STS policy body", () => {
  it("is CRLF-delimited (RFC 8461 §3.2 — LF-only is malformed)", () => {
    expect(MTA_STS_POLICY).toContain("\r\n");
    // No bare LF anywhere.
    expect(MTA_STS_POLICY.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("declares STSv1 and a mode", () => {
    expect(MTA_STS_POLICY).toMatch(/^version: STSv1\r\n/);
    expect(MTA_STS_POLICY).toMatch(/\r\nmode: (testing|enforce|none)\r\n/);
  });

  it("lists the iCloud MX by WILDCARD so a future mx03 does not break delivery", () => {
    // RFC 8461: `*` may only match the entire left-most label. `*.mail.icloud.com` covers
    // mx01/mx02 AND any sibling Apple adds later. Pinning mx01/mx02 literally is a latent outage.
    expect(MTA_STS_POLICY).toMatch(/\r\nmx: \*\.mail\.icloud\.com\r\n/);
  });

  it("has a max_age", () => {
    const maxAge = Number(MTA_STS_POLICY.match(/\r\nmax_age: (\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    // max_age is a self-imposed lock-in window: under `enforce`, senders honour a CACHED policy for
    // up to this long, so migrating MX away from iCloud without waiting it out stops mail. Keep it
    // short (1 day) until the policy is proven by TLS-RPT.
    expect(maxAge).toBeLessThanOrEqual(86400);
  });

  // The `id=` in the _mta-sts DNS TXT record is what tells senders to re-fetch. Edit the policy and
  // forget to bump it, and senders keep the stale cached policy forever. Binding the id to a hash of
  // the body makes that mistake impossible to ship: change the body, this test goes red.
  it("has an id that is a hash of the policy body (forces a DNS bump on any edit)", () => {
    const expected = createHash("sha256").update(MTA_STS_POLICY).digest("hex").slice(0, 16);
    expect(
      MTA_STS_POLICY_ID,
      `Policy body changed. Set MTA_STS_POLICY_ID to "${expected}" AND update the DNS TXT record:\n` +
        `  _mta-sts.webhook.co  TXT  "v=STSv1; id=${expected};"`,
    ).toBe(expected);
  });
});

describe("mtaStsResponse routing", () => {
  const wellKnown = `https://${MTA_STS_HOST}/.well-known/mta-sts.txt`;

  it("serves the policy as text/plain at the well-known path", async () => {
    const res = mtaStsResponse(new URL(wellKnown));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // Senders SHOULD validate the media type; text/html (a Worker default) is rejected.
    expect(res!.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res!.text()).toBe(MTA_STS_POLICY);
  });

  it("404s any other path on the policy host (it is not a website)", () => {
    expect(mtaStsResponse(new URL(`https://${MTA_STS_HOST}/`))!.status).toBe(404);
    expect(mtaStsResponse(new URL(`https://${MTA_STS_HOST}/pricing`))!.status).toBe(404);
  });

  it("returns null for every other host, so www is untouched", () => {
    expect(mtaStsResponse(new URL("https://www.webhook.co/"))).toBeNull();
    expect(mtaStsResponse(new URL("https://www.webhook.co/.well-known/mta-sts.txt"))).toBeNull();
  });
});
