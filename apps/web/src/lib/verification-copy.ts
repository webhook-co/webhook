import type { VerificationResult } from "@webhook-co/webhooks-spec";

// Map the structured `verification` field of an event to a human-readable tone + copy for the detail
// view. The `verified` boolean alone is LOSSY: `verified=false` collapses two very different states —
// (a) verification was attempted and FAILED (a non-null `ok:false` reason) and (b) it was never
// attempted (`verification === null`, e.g. no signing secret configured). Only the detail reads the
// structured field, so only here can we tell those apart — and we MUST, or every unsigned event looks
// like a failure. Red ("danger") is reserved for a genuine failure; "never attempted" is neutral.

export type VerificationTone = "ok" | "neutral" | "danger";

export interface VerificationCopy {
  /** The functional tone — ok (verified), neutral (not attempted), danger (verification failed). */
  readonly tone: VerificationTone;
  /** A short pill label. */
  readonly pill: string;
  /** A one-sentence diagnostic for the developer. */
  readonly detail: string;
}

const FAILED = "Verification failed";

export function verificationCopy(verification: VerificationResult | null): VerificationCopy {
  // Never attempted — NOT a failure. The common state for an org that hasn't configured a secret yet.
  if (verification === null) {
    return {
      tone: "neutral",
      pill: "Not verified",
      detail:
        "No signing secret was configured for this endpoint when the event arrived, so the signature wasn't checked.",
    };
  }

  if (verification.ok) {
    return {
      tone: "ok",
      pill: "Verified",
      detail: `Signature verified — ${verification.scheme} scheme (key ${verification.keyId}).`,
    };
  }

  const reason = verification.reason;
  switch (reason.code) {
    case "MISSING_HEADER":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The ${reason.scheme} signature header ${reason.header} was missing.`,
      };
    case "MALFORMED_SIGNATURE":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The ${reason.scheme} signature header was malformed: ${reason.detail}.`,
      };
    case "UNSUPPORTED_SCHEME":
      return {
        tone: "danger",
        pill: FAILED,
        detail: reason.observedHeaders.length
          ? `No supported signature scheme matched the headers received (${reason.observedHeaders.join(", ")}).`
          : "No signature headers were present, so no supported scheme could be matched.",
      };
    case "TIMESTAMP_TOO_OLD":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The signature timestamp was ${reason.skewSeconds}s old, beyond the ${reason.toleranceSeconds}s tolerance (possible replay).`,
      };
    case "TIMESTAMP_IN_FUTURE":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The signature timestamp was ${reason.skewSeconds}s in the future, beyond the ${reason.toleranceSeconds}s tolerance (check for clock skew).`,
      };
    case "NO_MATCHING_KEY":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `None of the ${reason.keysTried} configured signing key(s) produced a matching signature.`,
      };
    case "WRONG_SECRET":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The signature didn't match — the configured secret is likely wrong (${reason.confidence} confidence).`,
      };
    case "RAW_BODY_MODIFIED":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `The request body appears to have been modified in transit${
          reason.evidence
            ? ` (${reason.evidence === "trailing_whitespace" ? "trailing whitespace added" : "JSON re-encoded"})`
            : ""
        } (${reason.confidence} confidence).`,
      };
    case "PROXY_MUTATED_BYTES":
      return {
        tone: "danger",
        pill: FAILED,
        detail: `A proxy appears to have altered the raw bytes before delivery (${reason.confidence} confidence).`,
      };
    case "SIGNATURE_MISMATCH":
      return {
        tone: "danger",
        pill: FAILED,
        detail: "The signature did not match the payload.",
      };
  }
  // Exhaustive switch: every `reason.code` returns above. A new code added to the contract union leaves
  // this path reachable with no return → a compile error (TS2366), forcing a copy entry for it.
}
