import { describe, expect, it } from "vitest";

import { evaluateAutoApprove } from "./auto-approve";

// Pure coverage for the org_policy.auto_approve_rules evaluator (Lane B A0c). A device-grant is
// auto-approved when ANY rule fully matches (OR across rules); within a rule, EVERY present
// condition must match (AND within). The evaluator is FAIL-CLOSED: absent/empty/malformed rules
// never auto-approve. The upstream trust of ctx.ip / ctx.geoCountry (set by Lane C from
// request.cf) is a Lane C concern; this validates shape + matches, conservatively.

describe("evaluateAutoApprove — IP-CIDR", () => {
  it("approves when the request IP is within an allowed IPv4 CIDR", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["192.168.0.0/16"] }], { ip: "192.168.5.5" })).toBe(
      true,
    );
  });

  it("denies when the IP is outside every CIDR", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["192.168.0.0/16"] }], { ip: "10.0.0.1" })).toBe(false);
  });

  it("matches an IPv6 CIDR and denies outside it", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["2001:db8::/32"] }], { ip: "2001:db8::1" })).toBe(true);
    expect(evaluateAutoApprove([{ ipCidrs: ["2001:db8::/32"] }], { ip: "2001:dead::1" })).toBe(
      false,
    );
  });

  it("denies when the rule needs an IP but the context has none", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/8"] }], {})).toBe(false);
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/8"] }], { ip: null })).toBe(false);
  });

  it("does not match an IPv4 context against an IPv6-only rule (family mismatch)", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["2001:db8::/32"] }], { ip: "192.168.0.1" })).toBe(
      false,
    );
  });
});

describe("evaluateAutoApprove — geo + sso", () => {
  it("approves on a geo-country allow-list, case-insensitively", () => {
    expect(evaluateAutoApprove([{ geoCountries: ["US", "CA"] }], { geoCountry: "us" })).toBe(true);
    expect(evaluateAutoApprove([{ geoCountries: ["US", "CA"] }], { geoCountry: "FR" })).toBe(false);
    expect(evaluateAutoApprove([{ geoCountries: ["US"] }], {})).toBe(false);
  });

  it("requireSso approves only an SSO-verified request", () => {
    expect(evaluateAutoApprove([{ requireSso: true }], { ssoVerified: true })).toBe(true);
    expect(evaluateAutoApprove([{ requireSso: true }], { ssoVerified: false })).toBe(false);
    expect(evaluateAutoApprove([{ requireSso: true }], {})).toBe(false);
  });
});

describe("evaluateAutoApprove — AND within / OR across", () => {
  it("AND within a rule: every present condition must match", () => {
    const rules = [{ ipCidrs: ["10.0.0.0/8"], geoCountries: ["US"] }];
    expect(evaluateAutoApprove(rules, { ip: "10.1.1.1", geoCountry: "US" })).toBe(true);
    expect(evaluateAutoApprove(rules, { ip: "10.1.1.1", geoCountry: "FR" })).toBe(false);
    expect(evaluateAutoApprove(rules, { ip: "11.0.0.1", geoCountry: "US" })).toBe(false);
  });

  it("OR across rules: any fully-matching rule approves", () => {
    const rules = [{ geoCountries: ["US"] }, { ipCidrs: ["10.0.0.0/8"] }];
    expect(evaluateAutoApprove(rules, { ip: "10.2.2.2", geoCountry: "FR" })).toBe(true);
    expect(evaluateAutoApprove(rules, { geoCountry: "US" })).toBe(true);
    expect(evaluateAutoApprove(rules, { ip: "1.2.3.4", geoCountry: "FR" })).toBe(false);
  });
});

describe("evaluateAutoApprove — fail-closed", () => {
  it("never approves on absent or empty rules", () => {
    expect(evaluateAutoApprove(null, { ip: "10.0.0.1" })).toBe(false);
    expect(evaluateAutoApprove(undefined, { ip: "10.0.0.1" })).toBe(false);
    expect(evaluateAutoApprove([], { ip: "10.0.0.1" })).toBe(false);
  });

  it("rejects a non-array rules value", () => {
    expect(evaluateAutoApprove("anything" as unknown, { ip: "10.0.0.1" })).toBe(false);
    expect(evaluateAutoApprove({ ipCidrs: ["10.0.0.0/8"] } as unknown, { ip: "10.0.0.1" })).toBe(
      false,
    );
  });

  it("rejects a rule with NO conditions (an empty rule must not match-all)", () => {
    expect(evaluateAutoApprove([{}] as unknown, { ip: "10.0.0.1" })).toBe(false);
  });

  it("rejects a malformed CIDR / prefix", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["not-a-cidr"] }] as unknown, { ip: "10.0.0.1" })).toBe(
      false,
    );
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/99"] }] as unknown, { ip: "10.0.0.1" })).toBe(
      false,
    );
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0"] }] as unknown, { ip: "10.0.0.1" })).toBe(
      false,
    );
  });

  it("rejects a malformed country code or non-boolean requireSso", () => {
    expect(evaluateAutoApprove([{ geoCountries: ["USA"] }] as unknown, { geoCountry: "US" })).toBe(
      false,
    );
    expect(evaluateAutoApprove([{ requireSso: "yes" }] as unknown, { ssoVerified: true })).toBe(
      false,
    );
  });

  it("fails closed for the whole set if ANY rule is malformed (conservative)", () => {
    const rules = [{ geoCountries: ["US"] }, { ipCidrs: ["not-a-cidr"] }];
    expect(evaluateAutoApprove(rules as unknown, { geoCountry: "US" })).toBe(false);
  });

  it("treats requireSso:false as a no-op — a SOLE {requireSso:false} is NOT a match-all", () => {
    // The dangerous fail-open: a false (or omitted) SSO requirement imposes nothing, so a rule whose
    // only key is requireSso:false must be rejected (no positive constraint), never approve-all.
    expect(evaluateAutoApprove([{ requireSso: false }] as unknown, { ip: "10.0.0.1" })).toBe(false);
    expect(evaluateAutoApprove([{ requireSso: false }] as unknown, {})).toBe(false);
    // But requireSso:false ALONGSIDE a real constraint is fine — it just doesn't add an SSO gate.
    expect(
      evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/8"], requireSso: false }] as unknown, {
        ip: "10.1.1.1",
      }),
    ).toBe(true);
  });

  it("rejects an unknown extra key (strict schema, no sneaked match-all)", () => {
    expect(evaluateAutoApprove([{ allowAll: true } as unknown], { ip: "10.0.0.1" } as never)).toBe(
      false,
    );
  });

  it("rejects a /0 match-all CIDR", () => {
    expect(evaluateAutoApprove([{ ipCidrs: ["0.0.0.0/0"] }] as unknown, { ip: "8.8.8.8" })).toBe(
      false,
    );
    expect(evaluateAutoApprove([{ ipCidrs: ["::/0"] }] as unknown, { ip: "2001:db8::1" })).toBe(
      false,
    );
  });

  it("rejects a country context whose unicode uppercase would expand into a stored code", () => {
    // "ß".toUpperCase() === "SS" (South Sudan). The raw context must be ASCII alpha-2, so this fails.
    expect(evaluateAutoApprove([{ geoCountries: ["SS"] }], { geoCountry: "ß" })).toBe(false);
  });

  it("matches an IPv4-mapped IPv6 context against an IPv4 rule (pinned, allow-list semantics)", () => {
    // ::ffff:10.5.5.5 IS 10.5.5.5; in-range matches, out-of-range does not — presentation-independent.
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/8"] }], { ip: "::ffff:10.5.5.5" })).toBe(
      true,
    );
    expect(evaluateAutoApprove([{ ipCidrs: ["10.0.0.0/8"] }], { ip: "::ffff:8.8.8.8" })).toBe(
      false,
    );
  });
});
