// Consent-screen display helpers. A client's self-asserted `client_name` is attacker-controlled (DCR
// validates only redirect_uris; a CIMD metadata doc is self-hosted), yet it's the consent headline. These
// pure helpers make it safe to render and derive the UN-spoofable signals — the client's proven identity
// domain and the redirect host — that the origin-honest consent screen shows alongside it.
//
// This is the anti-phishing posture Google / Microsoft / GitHub / Bluesky use: never trust the name; show
// the domain. The name is a convenience label, never the identity.

import { isCimdClientId } from "./dcr";

const MAX_NAME_LENGTH = 80;
const NEUTRAL_NAME = "Unnamed app";

// Characters stripped from a display name: C0 controls (minus U+0009–U+000D, kept so they collapse to a
// space) + DEL + C1; the ARABIC LETTER MARK; the bidi overrides / embeddings / isolates that can visually
// reorder a headline; the zero-width / word-joiner / BOM / interlinear-annotation formatters; variation
// selectors; and Unicode tag characters (invisible, can smuggle a hidden payload). Built via
// `new RegExp(string)` rather than a regex literal so the ranges — control + combining code points by
// design — don't trip `no-control-regex` / `no-misleading-character-class`, which only analyse regex
// literals. This file therefore carries none of the characters it strips.
// The variation-selector ranges are combining code points; including them in a character class is exactly
// what no-misleading-character-class warns about — but stripping these invisible/combining chars is the
// intent, so the rule is disabled for this one declaration.
/* eslint-disable no-misleading-character-class */
const STRIP = new RegExp(
  "[\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u202A-\\u202E" +
    "\\u2060-\\u2064\\u2066-\\u2069\\uFE00-\\uFE0F\\uFEFF\\uFFF9-\\uFFFB" +
    "\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]",
  "gu",
);
/* eslint-enable no-misleading-character-class */

/**
 * Make an attacker-supplied client name safe to render: strip control + bidi + zero-width characters,
 * collapse whitespace, clamp length (with an ellipsis), and fall back to a neutral label if nothing usable
 * remains. React already escapes HTML, so this defends against visual reordering + layout overflow, not XSS.
 */
export function sanitizeClientName(raw: string): string {
  const cleaned = raw.replace(STRIP, "").replace(/\s+/g, " ").trim();
  if (cleaned === "") return NEUTRAL_NAME;
  // Clamp on CODE POINTS (Array.from), not UTF-16 units, so the cut never splits an astral char (emoji,
  // CJK-B) into a lone surrogate that renders as a replacement glyph.
  const points = Array.from(cleaned);
  if (points.length <= MAX_NAME_LENGTH) return cleaned;
  return `${points
    .slice(0, MAX_NAME_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * The client's proven-controlled identity domain — the host of a CIMD https client_id. Null for an opaque
 * DCR client id (there is no domain the client has demonstrably proven control of, so the screen shows no
 * identity domain and treats the client as unverified).
 */
export function clientIdentityDomain(clientId: string): string | null {
  if (!isCimdClientId(clientId)) return null;
  try {
    return new URL(clientId).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The redirect host to display (MCP spec: the AS MUST show the redirect hostname during authorization) and
 * whether it's a loopback (the screen warns on localhost-only redirects — CIMD can't prevent localhost
 * impersonation, so the user is told the code goes to their own machine).
 */
export function redirectHostLabel(redirectUri: string): {
  host: string | null;
  isLoopback: boolean;
} {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { host: null, isLoopback: false };
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const isLoopback =
    url.protocol === "http:" &&
    (host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host));
  return { host, isLoopback };
}
