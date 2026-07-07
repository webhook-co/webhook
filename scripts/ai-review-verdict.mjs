// Parses the machine-readable verdict an AI reviewer appends to its review.
//
// The AI-review CI (.github/workflows/ai-review.yml) asks each provider (Cursor,
// Claude) to end its review with a final line that is EXACTLY `VERDICT: BLOCK` or
// `VERDICT: PASS`. The gate step imports parseVerdict() to turn that into a
// pass/fail signal, so the logic that decides a *required* merge check lives in one
// tested place instead of an inline regex.
//
// Contract: the verdict must be the LAST non-empty line, matching the whole line
// (case-insensitive). Anything else — trailing prose, a mid-review "VERDICT:" line,
// a malformed line, missing output — returns null, which the gate treats as an
// incomplete review (fail-closed when a provider was configured).

/**
 * @param {unknown} raw - full review text (contents of ai-review-output.md)
 * @returns {"BLOCK" | "PASS" | null}
 */
export function parseVerdict(raw) {
  if (typeof raw !== "string") return null;

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];
  const match = /^VERDICT:\s*(BLOCK|PASS)$/i.exec(lastLine);
  return match ? /** @type {"BLOCK" | "PASS"} */ (match[1].toUpperCase()) : null;
}
