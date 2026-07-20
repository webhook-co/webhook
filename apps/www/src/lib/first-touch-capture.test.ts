import { FIRST_TOUCH_COOKIE } from "@webhook-co/shared/first-touch-cookie";
import { describe, expect, it } from "vitest";

import { CONSENT_COOKIE } from "./consent";
import { withFirstTouchCookie } from "./first-touch-capture";

// Server-side first-touch capture on the www worker, CONSENT-GATED: it sets the first-party `.webhook.co`
// first-touch cookie on an HTML page view carrying utm ONLY when the request already carries
// `wh_consent=granted` (a returning, already-consented visitor arriving via a new marketing link).
// First-touch-WINS. Best-effort — serving the page must never depend on it. The first-consent moment itself
// is handled client-side by the banner (see consent.ts / ConsentBanner.tsx), not here.

const GRANTED = `${CONSENT_COOKIE}=granted`;

const html = (): Response =>
  new Response("<!doctype html><title>ok</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const req = (path: string, opts: { host?: string; cookie?: string } = {}): Request =>
  new Request(`https://${opts.host ?? "www.webhook.co"}${path}`, {
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });

const setCookie = (res: Response): string | null => res.headers.get("set-cookie");

describe("withFirstTouchCookie", () => {
  it("sets a .webhook.co HttpOnly cookie on an HTML view carrying utm WHEN consent is granted", () => {
    const res = withFirstTouchCookie(
      req("/pricing?utm_source=twitter&utm_medium=social&utm_campaign=launch", { cookie: GRANTED }),
      html(),
    );
    const c = setCookie(res);
    expect(c).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(c).toContain("s=twitter");
    expect(c).toContain("m=social");
    expect(c).toContain("c=launch");
    expect(c).toContain("Domain=.webhook.co");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
  });

  it("sets NOTHING when consent has not been given (even with utm) — ePrivacy gate", () => {
    const res = withFirstTouchCookie(req("/pricing?utm_source=twitter"), html());
    expect(setCookie(res)).toBeNull();
  });

  it("sets NOTHING when consent is explicitly denied (even with utm)", () => {
    const res = withFirstTouchCookie(
      req("/pricing?utm_source=twitter", { cookie: `${CONSENT_COOKIE}=denied` }),
      html(),
    );
    expect(setCookie(res)).toBeNull();
  });

  it("is first-touch-WINS: does NOT overwrite an existing first-touch cookie", () => {
    const res = withFirstTouchCookie(
      req("/pricing?utm_source=twitter", { cookie: `${GRANTED}; ${FIRST_TOUCH_COOKIE}=s=google` }),
      html(),
    );
    expect(setCookie(res)).toBeNull();
  });

  it("sets nothing when the page carries no utm (even with consent)", () => {
    expect(
      setCookie(withFirstTouchCookie(req("/pricing", { cookie: GRANTED }), html())),
    ).toBeNull();
  });

  it("sets nothing on a non-HTML asset (e.g. a JS chunk) even with utm + consent", () => {
    const asset = new Response("//js", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    expect(
      setCookie(withFirstTouchCookie(req("/_next/x.js?utm_source=x", { cookie: GRANTED }), asset)),
    ).toBeNull();
  });

  it("uses a host-only cookie (no Domain) on localhost / preview hosts", () => {
    const res = withFirstTouchCookie(
      req("/?utm_source=x", { host: "localhost:3000", cookie: GRANTED }),
      html(),
    );
    const c = setCookie(res);
    expect(c).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(c).not.toContain("Domain=");
  });

  it("preserves the response body + status when it captures", async () => {
    const res = withFirstTouchCookie(req("/?utm_source=hn", { cookie: GRANTED }), html());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>ok</title>");
  });

  it("returns the original response unchanged when there is nothing to set (same object)", () => {
    const original = html();
    expect(withFirstTouchCookie(req("/pricing", { cookie: GRANTED }), original)).toBe(original);
  });
});
