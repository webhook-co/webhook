// The org_policy.auto_approve_rules evaluator (Lane B A0c). A device-authorization grant can be
// auto-approved (no human in the loop) when it satisfies a policy the org admin set. This is a PURE
// decision engine: given the stored rules (jsonb) and a request context, return true to auto-approve.
//
// Semantics: OR ACROSS rules (auto-approve if ANY rule matches), AND WITHIN a rule (every present
// condition must match). A rule MUST constrain at least one signal — an empty rule is rejected, never
// a match-all. The evaluator is FAIL-CLOSED: absent / empty / malformed rules never auto-approve, so
// a bad policy or a parse failure pauses for human approval rather than waving a grant through.
//
// v1 dormant: nothing flips require_device_approval ON yet (the admin-console epic owns that UI), so
// this engine ships tested-in-isolation. The trust of ctx.ip / ctx.geoCountry (Lane C sets them from
// Cloudflare request.cf) is a Lane C concern; this layer validates shape + matches conservatively.

import net from "node:net";

import { z } from "zod";

/** The request signals an auto-approve decision is made against. */
export interface AutoApproveContext {
  /** Source IP (string form), or null/absent if unknown. */
  readonly ip?: string | null;
  /** ISO 3166-1 alpha-2 country (any case), or null/absent if unknown. */
  readonly geoCountry?: string | null;
  /** Whether the request was verified through SSO. */
  readonly ssoVerified?: boolean;
}

/** A CIDR whose network part is a valid IP and whose prefix is in range for that family. */
const cidr = z.string().refine((value) => {
  const slash = value.indexOf("/");
  if (slash < 0) return false; // a bare address is not a CIDR — require an explicit prefix
  const addr = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  const family = net.isIP(addr); // 4, 6, or 0 (invalid)
  if (family === 0) return false;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  // Reject a /0 (the only true match-all-by-IP) for consistency with the no-match-all intent; a
  // genuine allow-list always constrains at least one bit. Floor is 1, ceiling is the family width.
  return bits >= 1 && bits <= (family === 6 ? 128 : 32);
}, "invalid CIDR");

/** ISO 3166-1 alpha-2, normalized to upper-case. */
const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "invalid ISO 3166-1 alpha-2 country")
  .transform((c) => c.toUpperCase());

/** A single rule: every present condition must match (AND). At least one condition is required. */
const AutoApproveRuleSchema = z
  .object({
    ipCidrs: z.array(cidr).nonempty().optional(),
    geoCountries: z.array(country).nonempty().optional(),
    requireSso: z.boolean().optional(),
  })
  .strict()
  .refine(
    // A rule must impose at least one POSITIVE constraint. `requireSso: false` is a no-op (it imposes
    // nothing — same as omitting it), so a rule whose ONLY key is `requireSso: false` would otherwise
    // be a match-all that auto-approves everything. Require requireSso === true to count it.
    (r) => r.ipCidrs !== undefined || r.geoCountries !== undefined || r.requireSso === true,
    "a rule must impose at least one positive constraint (no match-all)",
  );

/** The stored auto_approve_rules shape: a list of rules (OR across). */
export const AutoApproveRulesSchema = z.array(AutoApproveRuleSchema);

export type AutoApproveRule = z.infer<typeof AutoApproveRuleSchema>;

/**
 * True iff `ip` falls within any of the (already-validated) CIDRs, matching address family.
 * Note (intentional): an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) matches an IPv4 rule for its
 * embedded address — net.BlockList treats the mapped form as the IPv4 it represents. This is correct
 * for an allow-list (the mapped address IS that IPv4; an out-of-range mapped IP still fails), so the
 * client's IPv4-vs-mapped presentation can't change the decision. Pinned by a test.
 */
function ipInAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false; // an invalid context IP never matches (fail-closed)
  const list = new net.BlockList();
  for (const c of cidrs) {
    const slash = c.indexOf("/");
    const addr = c.slice(0, slash);
    const bits = Number(c.slice(slash + 1));
    list.addSubnet(addr, bits, net.isIPv6(addr) ? "ipv6" : "ipv4");
  }
  return list.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** AND-within: every present condition must match the context. */
function ruleMatches(rule: AutoApproveRule, ctx: AutoApproveContext): boolean {
  if (rule.ipCidrs !== undefined) {
    if (ctx.ip == null || !ipInAnyCidr(ctx.ip, rule.ipCidrs)) return false;
  }
  if (rule.geoCountries !== undefined) {
    // Validate the raw context value is a plain ASCII alpha-2 BEFORE upper-casing. Otherwise a single
    // Unicode char whose uppercase expands to two ASCII letters (ß→"SS", ﬀ→"FF") could match a stored
    // code. ASCII letters never change length under toUpperCase, so this closes the case-folding gap.
    const cc = ctx.geoCountry;
    if (cc == null || !/^[A-Za-z]{2}$/.test(cc) || !rule.geoCountries.includes(cc.toUpperCase())) {
      return false;
    }
  }
  if (rule.requireSso === true && ctx.ssoVerified !== true) return false;
  return true;
}

/**
 * Decide whether a device grant may be auto-approved. Returns true iff the rules parse cleanly AND at
 * least one rule fully matches the context. Anything malformed / absent / empty returns false
 * (fail-closed) — the caller then routes the grant to pending_approval. `rules` is the raw stored
 * jsonb (unknown): a single bad rule fails the whole set closed, conservatively.
 */
export function evaluateAutoApprove(rules: unknown, ctx: AutoApproveContext): boolean {
  const parsed = AutoApproveRulesSchema.safeParse(rules);
  if (!parsed.success) return false; // malformed/absent → never auto-approve
  return parsed.data.some((rule) => ruleMatches(rule, ctx));
}
