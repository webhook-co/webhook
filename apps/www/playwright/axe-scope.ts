// What the accessibility audit is allowed to look at.
//
// The footer embeds Phare's live-status badge as TWO cross-origin iframes (a light and a dark variant,
// one of which is always hidden). axe-core walks into frames to audit them, and both facts about these
// ones make that a bad idea:
//
//   1. They are a VENDOR's markup on a VENDOR's origin. Nothing we can do fixes a violation found in
//      there, so a finding is not actionable — it is just a red suite.
//   2. They are cross-origin, so the injection axe needs either fails or races. That is the flake: when
//      it goes wrong it takes the WHOLE run with it, which is why this suite fails ~55 tests at once
//      rather than one or two. A shared cause with a shared symptom.
//
// Excluding them keeps the audit on markup we own and can fix. It narrows what is checked, which is
// worth being explicit about rather than quietly scoping the suite down: everything OUTSIDE these two
// iframes — the whole of our own footer, including the surrounding layout and the badge's container —
// is still audited exactly as before.

/** The Phare status-badge iframes. Matched on the vendor ORIGIN, so both theme variants are covered and
 *  a first-party iframe added later is NOT silently excluded along with them. */
export const THIRD_PARTY_STATUS_BADGE = 'iframe[src*="status.webhook.co"]';
