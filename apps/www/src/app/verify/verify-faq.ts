import type { FaqItem } from "@/components/marketing/faq";

// The signature-verification SERP rewards troubleshooting, not a definition: the pages that rank
// answer "why won't my signature match", and the raw-body pitfall is the single most common cause.
// These render BENEATH the verifier tool — the tool is the format that ranks, so it stays first and
// above the fold; the FAQ adds the substance the bare tool cannot, and is emitted as FAQPage JSON-LD.
//
// Plain text only: each answer is rendered into the DOM AND serialised into the schema, and Google
// requires the two to match. Kept in its own data module (no React) so the site-wide FAQ-uniqueness
// guard in `tutorials.test.ts` can import and enforce it — the "distinct from every other FAQ on the
// site" claim below is checked, not merely asserted in a comment.
export const VERIFY_FAQ: readonly FaqItem[] = [
  {
    question: "Why doesn't my webhook signature match?",
    answer:
      "Almost always because the bytes you verified aren't the bytes the sender signed. A web framework that parses the JSON body and hands you an object has already re-serialised it — different whitespace, different key order — so the hash no longer lines up. Verify against the raw request body, exactly as it arrived, before anything touches it.",
  },
  {
    question: "Do I hash the raw body or the parsed JSON?",
    answer:
      "The raw body. A signature is computed over the exact bytes that were sent, so re-serialising after JSON.parse reorders keys and drops whitespace, and any of that changes the hash. Capture the raw bytes first, verify, then parse.",
  },
  {
    question: "The secret looks right and it still fails — what else?",
    answer:
      "Check the timestamp. The Standard Webhooks scheme and several providers fold a timestamp into the signed value and reject anything outside a tolerance window, so a clock that has drifted, or a request you're replaying long after it was sent, fails even with the correct secret.",
  },
  {
    question: "Am I using the right signing secret?",
    answer:
      "Each endpoint has its own secret, and they are easy to cross. A secret copied from a different endpoint — or a local CLI's secret used against a dashboard-registered endpoint — verifies cleanly against the wrong payload and fails against yours. Confirm the secret belongs to the endpoint that received this exact request.",
  },
  {
    question: "Does anything I paste here leave my browser?",
    answer:
      "No. The payload, the signature and the secret are all processed in the page with Web Crypto and are never sent anywhere or stored. You can check a production secret here without it leaving your machine.",
  },
];
