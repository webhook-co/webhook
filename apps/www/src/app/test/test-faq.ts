import type { FaqItem } from "@/components/marketing/faq";

// Substance for the hybrid the "webhook testing" / "webhook tester" SERP rewards — the grid is the
// index and stays on top; this how-to FAQ renders strictly beneath it. Plain-text answers only: each
// is rendered into the DOM and serialised into FAQPage JSON-LD, and Google requires the two to match.
//
// Provider-agnostic on purpose — the per-provider detail lives in each tutorial, not here. Kept in its
// own data module (no React) so the site-wide FAQ-uniqueness guard in `tutorials.test.ts` can import
// and enforce that these questions are distinct from every other FAQ on the site.
export const TEST_FAQ: readonly FaqItem[] = [
  {
    question: "Can a provider send a webhook to localhost?",
    answer:
      "No. Deliveries come from the provider's own servers over the public internet, so localhost and 127.0.0.1 aren't reachable from where the request originates. Point the provider at a permanent public URL that forwards down to your machine instead.",
  },
  {
    question: "How do I test a webhook without deploying?",
    answer:
      "Capture the real request at a permanent URL and stream it to the handler running on your laptop. You see production-shaped traffic without shipping anything, and you can keep iterating on the handler against the same captured event.",
  },
  {
    question: "How do I replay a webhook?",
    answer:
      "Every captured request can be replayed on demand, as many times as you need. You debug against the exact event that failed instead of re-triggering it upstream and hoping the next one looks the same.",
  },
  {
    question: "Why doesn't my webhook show up on my machine?",
    answer:
      "Usually the provider can't reach the URL you gave it. The endpoint has to be a public HTTPS URL, and many providers accept only certain ports and won't follow a redirect. Confirm the request is arriving at the ingest URL first, then look at the handler.",
  },
];
