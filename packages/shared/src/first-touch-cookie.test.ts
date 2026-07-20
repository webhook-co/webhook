import { describe, expect, it } from "vitest";

import {
  buildFirstTouchCookie,
  decodeFirstTouch,
  encodeFirstTouch,
  FIRST_TOUCH_COOKIE,
  FIRST_TOUCH_MAX_AGE_SECONDS,
  firstTouchFromQuery,
} from "./first-touch-cookie";

// The first-touch acquisition cookie (activation follow-up). A first-party `.webhook.co` cookie set on the
// first utm-carrying visit and read by the auth signup hook. This module is the SINGLE source of the
// set/read wire format + attributes, shared by www, web, and auth. Pure + total (never throws): a hostile or
// truncated cookie must degrade to "no attribution", never break a page load or a signup.

describe("firstTouchFromQuery", () => {
  it("pulls the three utm dimensions from a query string", () => {
    expect(firstTouchFromQuery("?utm_source=Google&utm_medium=cpc&utm_campaign=launch")).toEqual({
      source: "Google",
      medium: "cpc",
      campaign: "launch",
    });
  });

  it("returns only the dimensions present (missing → undefined), and {} for no utm", () => {
    expect(firstTouchFromQuery("?utm_source=hn")).toEqual({ source: "hn" });
    expect(firstTouchFromQuery("?foo=bar")).toEqual({});
    expect(firstTouchFromQuery("")).toEqual({});
  });

  it("drops an over-long value (cookie-size safety) rather than storing it", () => {
    const long = "x".repeat(300);
    expect(firstTouchFromQuery(`?utm_source=${long}&utm_medium=email`)).toEqual({
      medium: "email",
    });
  });
});

describe("encode/decode round-trip", () => {
  it("round-trips a full touch", () => {
    const raw = { source: "twitter", medium: "social", campaign: "beta-2" };
    expect(decodeFirstTouch(encodeFirstTouch(raw))).toEqual(raw);
  });

  it("round-trips a partial touch (only present keys survive)", () => {
    expect(decodeFirstTouch(encodeFirstTouch({ source: "hn" }))).toEqual({ source: "hn" });
  });

  it("encodes an empty touch to the empty string (signal: nothing to set)", () => {
    expect(encodeFirstTouch({})).toBe("");
  });

  it("decode is total — garbage / empty / partial never throw and yield only clean keys", () => {
    expect(decodeFirstTouch("")).toEqual({});
    expect(decodeFirstTouch("::::not a cookie::::")).toEqual({});
    expect(decodeFirstTouch("s=ok&x=ignored")).toEqual({ source: "ok" });
  });

  it("survives an encoded value with reserved chars via url-encoding", () => {
    const raw = { source: "a b", campaign: "x&y=z" };
    expect(decodeFirstTouch(encodeFirstTouch(raw))).toEqual(raw);
  });
});

describe("buildFirstTouchCookie", () => {
  it("builds a Set-Cookie string with the shared attributes (prod domain)", () => {
    const c = buildFirstTouchCookie("s=google", { domain: ".webhook.co" });
    expect(c).toContain(`${FIRST_TOUCH_COOKIE}=s=google`);
    expect(c).toContain("Domain=.webhook.co");
    expect(c).toContain("Path=/");
    expect(c).toContain(`Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}`);
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
  });

  it("omits Domain when none is given (dev / localhost)", () => {
    expect(buildFirstTouchCookie("s=google", {})).not.toContain("Domain=");
  });

  it("clears the cookie with Max-Age=0 when value is null", () => {
    const c = buildFirstTouchCookie(null, { domain: ".webhook.co" });
    expect(c).toContain(`${FIRST_TOUCH_COOKIE}=;`);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Domain=.webhook.co");
  });
});
