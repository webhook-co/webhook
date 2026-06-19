// The `--since` grammar parser (ADR-0017 follow-on). PURE + TOTAL: every input returns a tagged result
// and NEVER throws — so the server maps an `invalid` to a typed VALIDATION_ERROR and the CLI can
// pre-validate identically (one definition, shared). Grammar:
//   `now` | `beginning` | <duration> (\d+ followed by s|m|h|d) | <RFC3339 instant>
// NEVER add a `--latest` value (Stripe overloaded it). RFC3339 is parsed STRICTLY: a zone designator is
// REQUIRED (a no-zone string silently localises) and the calendar is range-checked (a bare `new Date`
// rolls a `...-31` overflow into the next month instead of rejecting it).

export type Since =
  | { kind: "now" }
  | { kind: "beginning" }
  | { kind: "relative"; ms: number }
  | { kind: "timestamp"; date: Date }
  | { kind: "invalid"; reason: string };

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d{1,9})([smhd])$/;
// safe-regex is conservative about the optional fractional group below; the pattern is anchored (^…$)
// with only bounded quantifiers and no nested repetition (star-height 1), so matching is linear, not
// ReDoS-able. (Fractional seconds bounded to 1–9 digits; we truncate to ms downstream.)
const RFC3339 =
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded quantifiers, star-height 1
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export function parseSince(input: string): Since {
  if (input === "now") return { kind: "now" };
  if (input === "beginning") return { kind: "beginning" };

  const dur = DURATION.exec(input);
  if (dur) {
    const n = Number(dur[1]);
    const ms = n * UNIT_MS[dur[2]!]!;
    // n >= 1 (zero is meaningless — use `now`); the product must stay a safe integer.
    if (n < 1 || !Number.isSafeInteger(ms))
      return { kind: "invalid", reason: "duration out of range" };
    return { kind: "relative", ms };
  }

  const ts = RFC3339.exec(input);
  if (ts) {
    const y = Number(ts[1]);
    const mo = Number(ts[2]);
    const d = Number(ts[3]);
    const h = Number(ts[4]);
    const mi = Number(ts[5]);
    const s = Number(ts[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
      return { kind: "invalid", reason: "calendar field out of range" };
    }
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return { kind: "invalid", reason: "unparseable timestamp" };
    return { kind: "timestamp", date };
  }

  return { kind: "invalid", reason: "unrecognised --since value" };
}
