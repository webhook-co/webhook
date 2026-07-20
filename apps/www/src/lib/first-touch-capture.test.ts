import { FIRST_TOUCH_COOKIE } from "@webhook-co/shared/first-touch-cookie";
import { describe, expect, it } from "vitest";

import { withFirstTouchCookie } from "./first-touch-capture";

// Server-side first-touch capture on the www worker: set a first-party `.webhook.co` cookie on an HTML page
// view carrying utm, first-touch-WINS. Best-effort — serving the page must never depend on it.

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
  it("sets a .webhook.co HttpOnly cookie on an HTML view carrying utm", () => {
    const res = withFirstTouchCookie(
      req("/pricing?utm_source=twitter&utm_medium=social&utm_campaign=launch"),
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

  it("is first-touch-WINS: does NOT overwrite an existing first-touch cookie", () => {
    const res = withFirstTouchCookie(
      req("/pricing?utm_source=twitter", { cookie: `${FIRST_TOUCH_COOKIE}=s=google` }),
      html(),
    );
    expect(setCookie(res)).toBeNull();
  });

  it("sets nothing when the page carries no utm", () => {
    expect(setCookie(withFirstTouchCookie(req("/pricing"), html()))).toBeNull();
  });

  it("sets nothing on a non-HTML asset (e.g. a JS chunk) even with utm", () => {
    const asset = new Response("//js", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    expect(setCookie(withFirstTouchCookie(req("/_next/x.js?utm_source=x"), asset))).toBeNull();
  });

  it("uses a host-only cookie (no Domain) on localhost / preview hosts", () => {
    const res = withFirstTouchCookie(req("/?utm_source=x", { host: "localhost:3000" }), html());
    const c = setCookie(res);
    expect(c).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(c).not.toContain("Domain=");
  });

  it("preserves the response body + status when it captures", async () => {
    const res = withFirstTouchCookie(req("/?utm_source=hn"), html());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>ok</title>");
  });

  it("returns the original response unchanged when there is nothing to set (same object)", () => {
    const original = html();
    expect(withFirstTouchCookie(req("/pricing"), original)).toBe(original);
  });
});
