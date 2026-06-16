/**
 * Static, deterministic data for the live-inspector stage.
 *
 * Everything here is authored at build time — there is **no** `Math.random` or `Date.now` anywhere
 * in this module, the engine, or the render path. That's deliberate: the page is a static export
 * (`output: 'export'`), so the server-rendered HTML and the first client render must be byte-identical
 * or React throws a hydration mismatch. The stream "randomness" (which events arrive, which fail
 * verification, their latency) is baked into the ordered pool below; all motion happens later, inside
 * an effect-driven interval that only runs after the component mounts on the client.
 *
 * The numbers are illustrative — this is a marketing demo of what inspection looks like, not a real
 * feed. The UI says so out loud (see `inspector.tsx`).
 */

/** Why a signature check failed. Mirrors the real verification failure modes we surface elsewhere. */
export type SigFailReason = "timestamp_too_old" | "wrong_secret" | "raw_body_modified";

/** A signature-verification outcome: verified, or failed with a concrete reason. */
export type SigStatus = { ok: true } | { ok: false; reason: SigFailReason };

/** One webhook event, minus its identity. The pool and the seed are both built from these. */
export interface EventTemplate {
  /** Lowercase provider slug, e.g. `stripe`. */
  provider: string;
  /** Two-letter monogram shown in the row badge, e.g. `ST`. */
  badge: string;
  /** Dotted event name, e.g. `invoice.paid`. */
  event: string;
  /** A fixed, plausible verify+capture latency in milliseconds. Not random — see the module note. */
  latencyMs: number;
  /** Whether the signature verified, baked in so the verified/failed sequence is deterministic. */
  status: SigStatus;
}

/** A pool/seed event once it has a stable identity in the stream. */
export interface StreamRow extends EventTemplate {
  /** Stable React key. Seed rows are `seed-N`; appended rows are `evt-N` (monotonic). */
  id: string;
}

/** How many rows the stream shows at once; older rows fall off the bottom. */
export const MAX_ROWS = 5;

/**
 * The ordered pool the engine walks (modulo its length) to produce new rows. Exactly one entry fails
 * verification (`raw_body_modified`, index 4) — a fixed ~1-in-9 failure rate that the tests assert
 * deterministically, rather than a coin flip that would be both untestable and hydration-unsafe.
 */
export const EVENT_POOL: readonly EventTemplate[] = [
  { provider: "linear", badge: "LN", event: "issue.updated", latencyMs: 27, status: { ok: true } },
  {
    provider: "vercel",
    badge: "VC",
    event: "deployment.ready",
    latencyMs: 35,
    status: { ok: true },
  },
  {
    provider: "twilio",
    badge: "TW",
    event: "message.received",
    latencyMs: 46,
    status: { ok: true },
  },
  { provider: "slack", badge: "SK", event: "event.callback", latencyMs: 22, status: { ok: true } },
  {
    provider: "stripe",
    badge: "ST",
    event: "charge.refunded",
    latencyMs: 51,
    status: { ok: false, reason: "raw_body_modified" },
  },
  { provider: "github", badge: "GH", event: "pull_request", latencyMs: 33, status: { ok: true } },
  { provider: "resend", badge: "RS", event: "email.bounced", latencyMs: 19, status: { ok: true } },
  { provider: "clerk", badge: "CL", event: "session.created", latencyMs: 28, status: { ok: true } },
  {
    provider: "shopify",
    badge: "SH",
    event: "checkout.update",
    latencyMs: 44,
    status: { ok: true },
  },
];

/**
 * The five rows the stream paints on first render — identical on the server and the client. One is a
 * historical failure with a *different* reason (`timestamp_too_old`) so the static frame already shows
 * both a verified and a failed event without waiting for the stream to advance. Newest first.
 */
export const SEED_ROWS: readonly StreamRow[] = [
  {
    id: "seed-0",
    provider: "github",
    badge: "GH",
    event: "push",
    latencyMs: 29,
    status: { ok: true },
  },
  {
    id: "seed-1",
    provider: "stripe",
    badge: "ST",
    event: "invoice.paid",
    latencyMs: 24,
    status: { ok: true },
  },
  {
    id: "seed-2",
    provider: "shopify",
    badge: "SH",
    event: "orders.create",
    latencyMs: 61,
    status: { ok: false, reason: "timestamp_too_old" },
  },
  {
    id: "seed-3",
    provider: "resend",
    badge: "RS",
    event: "email.delivered",
    latencyMs: 18,
    status: { ok: true },
  },
  {
    id: "seed-4",
    provider: "clerk",
    badge: "CL",
    event: "user.created",
    latencyMs: 40,
    status: { ok: true },
  },
];

/** A fixed, plausible starting event count. Same on server and client — never derived from time. */
export const SEED_COUNTER = 1284;

/** Human-readable labels for the failure reasons, for the row's "failed — …" copy. */
export const FAIL_REASON_LABEL: Record<SigFailReason, string> = {
  timestamp_too_old: "timestamp too old",
  wrong_secret: "wrong secret",
  raw_body_modified: "raw body modified",
};
