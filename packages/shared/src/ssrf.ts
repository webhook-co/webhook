// SSRF guard primitives (pure, dependency-free) shared by the registration-time structural check
// (apps/api `replayDestinations.create`) and the connect-time guard (apps/engine DeliveryDispatcher).
// See ADR-0081.
//
// CIDR matching is hand-rolled BigInt arithmetic DELIBERATELY instead of node:net BlockList: the engine
// runs on workerd, where node:net is an unenv polyfill whose membership semantics are unverified — a stub
// that returned "no match" would fail OPEN (every address would pass the deny check). Pure arithmetic
// behaves identically on Node + workerd and fails CLOSED (an unparseable address is treated as blocked).

export type UrlValidation =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly reason: string };

// Ports a webhook destination may use. An allow-list (not a deny-list) is the conservative choice:
// the default (443) plus 8443. Other ports are rejected up front; relax deliberately if a real need
// appears. ("" is WHATWG's representation of the scheme-default port, which it strips for https:443.)
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/**
 * Parse + validate a user-supplied destination URL, returning its canonical form or a rejection reason.
 * STRUCTURAL only (no DNS): https-only, no credentials, no IP-literal host (every decimal/octal/hex/
 * short-form encoding canonicalizes to a dotted IPv4 via WHATWG URL, so the IP-literal check catches
 * them), an allowed port, and a multi-label FQDN (turns away `localhost` and bare internal names). The
 * AUTHORITATIVE defense against a hostname that RESOLVES to a private IP is the connect-time guard.
 */
export function canonicalizeAndValidateUrl(raw: string): UrlValidation {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "has_userinfo" };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: "disallowed_port" };

  // WHATWG URL brackets an IPv6 literal in hostname ("[::1]"); strip for the literal check.
  const lower = u.hostname.toLowerCase();
  const bareHost = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (parseIpToBig(bareHost) !== null) return { ok: false, reason: "ip_literal_host" };

  // Strip ALL trailing dots (a root-FQDN dot, or a malformed multi-dot like `example.com..`) so the
  // stored url is canonical — otherwise `example.com..` and `example.com` would resolve to the same DNS
  // target yet store as different strings and evade the live-url dedup index.
  const host = bareHost.replace(/\.+$/, "");
  if (host === "") return { ok: false, reason: "empty_host" };
  // A public webhook destination is always a multi-label FQDN — reject `localhost` / `intranet` /
  // made-up single-label names here (defense-in-depth; the connect-time guard still re-checks the IP).
  if (!host.includes(".")) return { ok: false, reason: "single_label_host" };
  // A canonical punycode host is ASCII letters/digits/dot/hyphen (underscores tolerated for lax DNS).
  if (!/^[a-z0-9._-]+$/.test(host)) return { ok: false, reason: "bad_host_chars" };
  // Reject an empty label (a leading dot or consecutive dots, e.g. `example..com` / `.example.com`) — a
  // malformed host WHATWG leaves intact that would otherwise dedupe inconsistently with its real form.
  if (host.split(".").some((label) => label === "")) return { ok: false, reason: "empty_label" };

  u.hostname = host;
  u.hash = ""; // a fragment is irrelevant to delivery; drop it for a stable stored form
  return { ok: true, url: u.toString(), host };
}

// ── IP parsing + CIDR deny-list ─────────────────────────────────────────────────────────────────────

interface Cidr {
  readonly net: bigint;
  readonly mask: bigint;
  readonly v6: boolean;
}

function makeCidr(addr: string, bits: number): Cidr {
  const v6 = addr.includes(":");
  const parsed = v6 ? parseIpv6(addr) : parseIpv4(addr);
  if (parsed === null) throw new Error(`bad CIDR in SSRF deny list: ${addr}/${bits}`);
  const width = v6 ? 128 : 32;
  const mask = bits === 0 ? 0n : (~0n << BigInt(width - bits)) & ((1n << BigInt(width)) - 1n);
  return { net: parsed & mask, mask, v6 };
}

function inCidr(ip: bigint, c: Cidr): boolean {
  return (ip & c.mask) === c.net;
}

// IPv4 denies: private, loopback, link-local (incl. the 169.254.169.254 metadata IP), CGNAT, multicast,
// reserved, and the documentation/benchmark blocks. Matched directly AND via embedded-v4 in IPv6.
const V4_DENY: readonly Cidr[] = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
    ["255.255.255.255", 32],
  ] as const
).map(([a, b]) => makeCidr(a, b));

// IPv6 denies: loopback/unspecified, link-local, ULA (fc00::/7), multicast, site-local, documentation,
// and the discard-only prefix. The exotic transition prefixes (NAT64 well-known + local-use, 6to4,
// Teredo) are blocked OUTRIGHT — they can wrap a private v4, and blocking the whole prefix is strictly
// safer than per-encoding extraction (a public 6to4/Teredo webhook target is deprecated + not real).
const V6_DENY: readonly Cidr[] = (
  [
    ["::1", 128],
    ["::", 128],
    ["fe80::", 10],
    ["fc00::", 7],
    ["ff00::", 8],
    ["fec0::", 10],
    ["2001:db8::", 32],
    ["100::", 64],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["2002::", 16],
    ["2001::", 32],
  ] as const
).map(([a, b]) => makeCidr(a, b));

/**
 * True iff `ip` (a v4 or v6 string) is in a blocked range. FAIL CLOSED: an unparseable address returns
 * true (blocked). IPv4-mapped (`::ffff:a.b.c.d`) and the deprecated IPv4-compatible (`::a.b.c.d`) forms
 * have their embedded v4 re-checked against the v4 deny set, so a private v4 can't sneak in as IPv6.
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return V4_DENY.some((c) => inCidr(v4, c));
  const v6 = parseIpv6(ip);
  if (v6 === null) return true; // unparseable → blocked
  const top96 = v6 >> 32n;
  const isMapped = top96 === 0xffffn; // ::ffff:0:0/96
  const isCompat = top96 === 0n; // ::/96 (includes :: and ::1, also covered by V6_DENY)
  if (isMapped || isCompat) {
    const embedded = v6 & 0xffffffffn;
    if (V4_DENY.some((c) => inCidr(embedded, c))) return true;
  }
  return V6_DENY.some((c) => inCidr(v6, c));
}

function parseIpToBig(s: string): bigint | null {
  return s.includes(":") ? parseIpv6(s) : parseIpv4(s);
}

/** Strict dotted-decimal IPv4 → 32-bit BigInt, or null. (WHATWG URL already canonicalizes other v4
 *  encodings to this form; DoH answers are canonical too — so a strict parser is correct here.) */
function parseIpv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null; // reject octal-looking leading zeros
    const n = Number(p);
    if (n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

/** IPv6 → 128-bit BigInt, or null. Handles a single `::`, full 8-group form, and a trailing embedded
 *  IPv4 (`::ffff:1.2.3.4`). Strict: anything malformed returns null (caller treats null as blocked). */
function parseIpv6(s: string): bigint | null {
  if (!s.includes(":")) return null;
  let str = s;
  // Convert a trailing embedded IPv4 ("…:1.2.3.4") to two hextets so the rest is pure hex groups.
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    str = str.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const parts = str.split("::");
  if (parts.length > 2) return null; // at most one "::"

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const out: number[] = [];
    for (const g of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (parts.length === 2) {
    const left = parseSide(parts[0] ?? "");
    const right = parseSide(parts[1] ?? "");
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    groups = [...left, ...Array<number>(missing).fill(0), ...right];
  } else {
    const all = parseSide(parts[0] ?? "");
    if (all === null) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) acc = (acc << 16n) | BigInt(g);
  return acc;
}
