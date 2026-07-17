// Attachment selection — the pure half of the email handler.
//
// The message reaching this Worker is a FORWARD: iCloud relays the reporter's mail, so the report is a
// nested attachment sitting beside whatever else the wrapper carries (signature images, the wrapper's own
// text parts). Taking the first attachment would happily pick a logo and then report the mail as
// unparseable — indistinguishable, from the outside, from a genuinely broken pipeline.
//
// Selection is by MAGIC BYTES, matching report.ts. Filenames come from the reporter and are not
// trustworthy: they are mislabelled in practice and attacker-controlled in principle.

export interface CandidateAttachment {
  readonly filename?: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
}

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** Does this look like XML? Cheap sniff over the first non-whitespace bytes — a bare .xml report is rare
 *  from the big reporters but is legal, and is what a hand-forwarded sample looks like. */
function looksLikeXml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
    .decode(bytes.subarray(0, 256))
    .trimStart();
  return head.startsWith("<?xml") || head.startsWith("<feedback");
}

/**
 * Pick the DMARC report attachment from a forwarded message, or `undefined` if none of them look like one.
 *
 * Returning `undefined` is a first-class answer, not a failure: "a message arrived carrying no report" and
 * "a report arrived and would not parse" are different facts, and the caller records them differently.
 */
export function selectReportAttachment(
  attachments: readonly CandidateAttachment[],
): CandidateAttachment | undefined {
  for (const a of attachments) {
    // No zero-length special case: startsWith() fails on a buffer shorter than the magic, and looksLikeXml
    // fails on an empty decode, so an empty attachment already falls through. (Verified by mutation — an
    // explicit `continue` here was dead code that read like a guard.)
    if (startsWith(a.content, GZIP_MAGIC)) return a;
    if (startsWith(a.content, ZIP_MAGIC)) return a;
    if (looksLikeXml(a.content)) return a;
  }
  return undefined;
}
