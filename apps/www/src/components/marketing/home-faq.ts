import type { FaqItem } from "@/components/marketing/faq";

/**
 * The homepage's FAQ. Deliberately a DIFFERENT set from the pricing FAQ: two pages emitting the same
 * FAQPage schema is duplicate structured data, and these answer a different question anyway.
 *
 * These are the ENTITY questions. The binding constraint on this site isn't design — it's that
 * "webhook.co" doesn't reliably resolve to us: it's a homonym of the generic noun and of several
 * similarly-named free tools. An answer engine can only repeat a claim it can find stated plainly.
 * So: what this is, what it is not, who builds it, and the awkward ones a buyer actually asks.
 *
 * Every answer is checkable against shipped code. `answer` is plain text (no markdown): it is
 * rendered into the DOM *and* serialised into the FAQPage schema, and the two must not diverge.
 */
export const HOME_FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "What is webhook.co?",
    answer:
      "webhook.co is an inbound webhook gateway. It gives you a permanent, signed URL to receive the webhooks other services send you, verifies each one's signature on arrival, keeps them in order, retries them, and lets you replay any of them — to your own machine or to a destination you choose. It is the layer between a provider's webhook and your application.",
  },
  {
    question: "Is this a webhook testing tool?",
    answer:
      "You can use it as one — the sandbox at /play gives you a throwaway URL with no signup, and the CLI replays real events to localhost while you build. But a tester throws the event away. webhook.co is built to sit in production: it captures the event durably before it acknowledges it, tells you why a signature failed, and retries a delivery your endpoint missed.",
  },
  {
    question: "Does webhook.co send webhooks to my customers?",
    answer:
      "Not yet. Today webhook.co is inbound: it receives, verifies, and delivers the webhooks you are sent, including replaying them onward to a destination you control. It does not publish webhook events on your behalf to your own customers' endpoints. We would rather say that plainly than imply a capability that isn't shipped.",
  },
  {
    question: "How is a signature verified, and what happens when it fails?",
    answer:
      "Signing and verification follow the Standard Webhooks specification, and 141 providers are built in, so you don't write the verification code or keep the signing secret in your app. When a check fails you get the named reason — the timestamp was outside the tolerance, the raw body was modified in transit, the secret didn't match — instead of a boolean false.",
  },
  {
    question: "Who builds it?",
    answer:
      "One person: Sourabh Choraria, working from Porto, Portugal. That is deliberate, and it sets an honest expectation — webhook.co is pre-launch, so the site describes what is shipped rather than what is planned.",
  },
  {
    question: "Is it open source, and can I self-host it?",
    answer:
      "The core is open source under Apache-2.0 — the engine that verifies and moves your events, the CLI, the MCP server, and the signing library. Proprietary code is fenced into a separate directory that a self-hosted build simply excludes. You can read exactly how a signature is checked before you trust it.",
  },
  {
    question: "What happens to my events if my endpoint is down?",
    answer:
      "The event is captured and durably stored before webhook.co acknowledges the provider, so it exists whether or not your endpoint does. Deliveries are retried with backoff, in order, and a delivery that never succeeds lands in a dead-letter queue you can inspect and replay — rather than disappearing.",
  },
];
