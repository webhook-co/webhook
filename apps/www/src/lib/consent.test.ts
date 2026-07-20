import { FIRST_TOUCH_COOKIE } from "@webhook-co/shared/first-touch-cookie";
import { describe, expect, it } from "vitest";

import {
  buildConsentCookie,
  CONSENT_COOKIE,
  consentWrites,
  cookieDomain,
  readConsent,
} from "./consent";

// The cookie-consent layer. `wh_first_touch` is a non-essential attribution cookie, so under ePrivacy it
// may only be set AFTER consent. `wh_consent` records the choice (granted/denied) and gates everything:
// the worker sets first-touch only when consent is already granted; the banner, on Accept, records consent
// AND promotes the current URL's utm to first-touch. This suite pins the pure decision logic — no DOM.

describe("readConsent", () => {
  it("returns null when there is no cookie header", () => {
    expect(readConsent(null)).toBeNull();
    expect(readConsent("")).toBeNull();
  });

  it("reads a granted decision", () => {
    expect(readConsent(`${CONSENT_COOKIE}=granted`)).toBe("granted");
  });

  it("reads a denied decision", () => {
    expect(readConsent(`${CONSENT_COOKIE}=denied`)).toBe("denied");
  });

  it("finds the consent cookie among others", () => {
    expect(readConsent(`foo=1; ${CONSENT_COOKIE}=granted; bar=2`)).toBe("granted");
  });

  it("returns null for an unrecognised value (never trusts arbitrary input)", () => {
    expect(readConsent(`${CONSENT_COOKIE}=yes`)).toBeNull();
    expect(readConsent(`${CONSENT_COOKIE}=`)).toBeNull();
  });

  it("returns null when the consent cookie is absent", () => {
    expect(readConsent(`other=1; ${FIRST_TOUCH_COOKIE}=s=x`)).toBeNull();
  });
});

describe("cookieDomain", () => {
  it("uses .webhook.co on the apex and its subdomains (so first-touch rides to auth)", () => {
    expect(cookieDomain("webhook.co")).toBe(".webhook.co");
    expect(cookieDomain("www.webhook.co")).toBe(".webhook.co");
    expect(cookieDomain("auth.webhook.co")).toBe(".webhook.co");
  });

  it("is host-only (no Domain) on localhost / preview hosts", () => {
    expect(cookieDomain("localhost")).toBeUndefined();
    expect(cookieDomain("preview.example.com")).toBeUndefined();
    // guards against a naive endsWith("webhook.co") that a look-alike could exploit
    expect(cookieDomain("notwebhook.co")).toBeUndefined();
    expect(cookieDomain("webhook.co.evil.com")).toBeUndefined();
  });
});

describe("buildConsentCookie", () => {
  it("builds a readable (NOT HttpOnly) granted cookie the banner logic can see", () => {
    const c = buildConsentCookie("granted", { domain: ".webhook.co" });
    expect(c).toContain(`${CONSENT_COOKIE}=granted`);
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(c).toContain("Domain=.webhook.co");
    expect(c).toContain("Max-Age=15552000"); // 180 days
    expect(c).not.toContain("HttpOnly"); // JS must read it to decide whether to show the banner
  });

  it("omits Domain when host-only", () => {
    expect(buildConsentCookie("denied")).not.toContain("Domain=");
  });
});

describe("consentWrites", () => {
  it("on grant with utm present, records consent AND sets first-touch (both .webhook.co)", () => {
    const w = consentWrites(
      "granted",
      {
        search: "?utm_source=twitter&utm_medium=social&utm_campaign=launch",
        hostname: "www.webhook.co",
      },
      null,
    );
    expect(w.consent).toContain(`${CONSENT_COOKIE}=granted`);
    expect(w.consent).toContain("Domain=.webhook.co");
    expect(w.firstTouch).not.toBeNull();
    expect(w.firstTouch).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(w.firstTouch).toContain("s=twitter");
    expect(w.firstTouch).toContain("m=social");
    expect(w.firstTouch).toContain("c=launch");
    expect(w.firstTouch).toContain("Domain=.webhook.co");
    expect(w.firstTouch).not.toContain("HttpOnly"); // client writes it via document.cookie
  });

  it("on grant with NO utm, records consent but sets no first-touch", () => {
    const w = consentWrites("granted", { search: "", hostname: "www.webhook.co" }, null);
    expect(w.consent).toContain(`${CONSENT_COOKIE}=granted`);
    expect(w.firstTouch).toBeNull();
  });

  it("on grant, is first-touch-WINS: never overwrites an existing first-touch cookie", () => {
    const w = consentWrites(
      "granted",
      { search: "?utm_source=twitter", hostname: "www.webhook.co" },
      `${FIRST_TOUCH_COOKIE}=s=google`,
    );
    expect(w.consent).toContain(`${CONSENT_COOKIE}=granted`);
    expect(w.firstTouch).toBeNull();
  });

  it("on deny, records the denial AND clears any first-touch cookie", () => {
    const w = consentWrites(
      "denied",
      { search: "?utm_source=twitter", hostname: "www.webhook.co" },
      `${FIRST_TOUCH_COOKIE}=s=google`,
    );
    expect(w.consent).toContain(`${CONSENT_COOKIE}=denied`);
    expect(w.firstTouch).not.toBeNull();
    expect(w.firstTouch).toContain(`${FIRST_TOUCH_COOKIE}=;`); // empty value
    expect(w.firstTouch).toContain("Max-Age=0"); // deletion
  });

  it("is host-only on localhost (no Domain on either cookie)", () => {
    const w = consentWrites("granted", { search: "?utm_source=x", hostname: "localhost" }, null);
    expect(w.consent).not.toContain("Domain=");
    expect(w.firstTouch).not.toBeNull();
    expect(w.firstTouch).not.toContain("Domain=");
  });
});
