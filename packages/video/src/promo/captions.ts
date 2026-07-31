// captions.ts — every on-screen string, in order, with its scene + frame window.
// Copied BYTE-FOR-BYTE from brief §6.1. These strings render on screen.
// Brand rules: lowercase brand names, sentence case, no exclamation points.
export const CAPTIONS = [
  { scene: "S1", from: 20, to: 90, kind: "hero", text: "Send a webhook." },
  { scene: "S2", from: 90, to: 150, kind: "pill", text: "https://wbhk.my/whep_abc" },
  { scene: "S3", from: 152, to: 210, kind: "hero", text: "Watch it land." },
  {
    scene: "S4",
    from: 214,
    to: 300,
    kind: "output",
    text: "2026-07-12T14:02:11.840Z  linear  verified  0197f0c1-6b3a-7a11-9f3e-2b6a4f0d9c21",
  },
  {
    scene: "S4",
    from: 270,
    to: 300,
    kind: "caption",
    text: "The full request. Headers and body. Exactly as received.",
  },
  { scene: "S5", from: 330, to: 360, kind: "caption", text: "captured durably before it acks" },
  { scene: "S6", from: 360, to: 450, kind: "url", text: "app.webhook.co/events" },
  { scene: "S6", from: 400, to: 450, kind: "hero", text: "Verified at the edge. 144 providers." },
  { scene: "S7", from: 474, to: 540, kind: "code", text: "RAW_BODY_MODIFIED" },
  {
    scene: "S7",
    from: 500,
    to: 540,
    kind: "caption",
    text: "a framework re-serialized the body before you verified it",
  },
  {
    scene: "S8",
    from: 540,
    to: 560,
    kind: "strike",
    text: "no signatures found matching the expected signature",
  },
  {
    scene: "S8",
    from: 580,
    to: 630,
    kind: "caption",
    text: "When a signature fails, you'll know why.",
  },
  {
    scene: "S9",
    from: 636,
    to: 720,
    kind: "legend",
    text: "verified · authenticated · failed · unattempted",
  },
  {
    scene: "S10",
    from: 724,
    to: 810,
    kind: "hero",
    text: "Received once, in order, never silently dropped.",
  },
  {
    scene: "S11",
    from: 814,
    to: 862,
    kind: "command",
    text: "wbhk listen --forward http://localhost:3000/webhooks",
  },
  {
    scene: "S11",
    from: 870,
    to: 900,
    kind: "caption",
    text: "Replay to localhost. One command. No redeploy.",
  },
  { scene: "S12", from: 905, to: 1020, kind: "overline", text: "same event. every surface." },
  {
    scene: "S13",
    from: 1024,
    to: 1110,
    kind: "hero",
    text: "Then hand your agents an event they can act on.",
  },
  { scene: "S14", from: 1114, to: 1230, kind: "mcp", text: "triggers.create" },
  { scene: "S15", from: 1234, to: 1350, kind: "mcp", text: "triggers.wait" },
  {
    scene: "S15",
    from: 1270,
    to: 1350,
    kind: "pill",
    text: "waiting · cursor-acked · at-least-once",
  },
  { scene: "S16", from: 1350, to: 1470, kind: "flow", text: "event → verified → agent → action" },
  { scene: "S17", from: 1470, to: 1500, kind: "reject", text: "forged event — never surfaced" },
  {
    scene: "S17",
    from: 1505,
    to: 1560,
    kind: "cap2",
    text: "can read the event. / can't reroute delivery.",
  },
  {
    scene: "S18",
    from: 1564,
    to: 1650,
    kind: "hero",
    text: "The webhook platform built for the agent era.",
  },
  { scene: "S19", from: 1654, to: 1740, kind: "hero", text: "Send a webhook. Watch it land." },
  { scene: "S19", from: 1685, to: 1740, kind: "wordmark", text: "webhook.co" },
  {
    scene: "S20",
    from: 1740,
    to: 1800,
    kind: "trust",
    text: "Open source · Apache-2.0 · Private by default",
  },
] as const;

/** The S6 hero line — "Verified at the edge. <n> providers." */
export const S6_HERO_TEXT = CAPTIONS.find((c) => c.scene === "S6" && c.kind === "hero")?.text ?? "";

/**
 * The number the S6 counter rolls up to, read OUT OF the caption above.
 *
 * S6 renders both at once: the counter ticks up and the caption settles directly beneath it. Written
 * as two literals they drift, and the scene shows a counter reaching one number under a sentence
 * stating another — so the counter is derived and there is one place the digit lives.
 *
 * Deriving has its own failure mode, and it is worth naming because the obvious guard does NOT cover
 * it: pinning the caption STRING in a test does not protect this pattern. Reword the line to
 * "144 signature schemes" and you update the caption and its pin together, the test stays green, and
 * the match quietly yields `undefined` → a counter that rolls 0→0. So this throws instead, and
 * `captions.test.ts` asserts the derived VALUE — that assertion, not the string pin, is the contract.
 */
function providerCountFromCaption(caption: string): number {
  const n = Number(caption.match(/(\d+)\s+providers/)?.[1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `promo S6: no "<n> providers" found in the hero caption ${JSON.stringify(caption)}. The ` +
        `counter renders this number directly above that line — keep the phrasing, or change the ` +
        `caption and this derivation together.`,
    );
  }
  return n;
}

export const S6_PROVIDER_COUNT = providerCountFromCaption(S6_HERO_TEXT);

// Real product tables rendered as pre-formatted blocks (byte-for-byte).
export const EVENTS_TABLE = [
  "RECEIVED                  PROVIDER  VERIFIED       ID",
  "2026-07-12T14:02:11.840Z  linear    verified       0197f0c1-...",
  "2026-07-12T14:02:38.114Z  github    verified       0197f0c2-...",
  "2026-07-12T14:03:02.902Z  gitlab    authenticated  0197f0c3-...",
] as const;
