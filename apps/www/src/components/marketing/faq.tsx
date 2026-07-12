import { cn } from "@webhook-co/ui";

import { container, focusRing, sectionPad } from "@/lib/styles";

import { OVERAGE_PER_MILLION } from "./pricing-tiers";

/**
 * The pricing FAQ.
 *
 * Two rules, inherited from the rest of this page:
 *
 *   1. **Say the real number, and don't let it rot.** The overage price is interpolated from
 *      `pricing-tiers.ts`. The retention windows and the free allowance are *not* — they read better
 *      as prose than as interpolations ("7 days on Free, 30 days on Pro…" vs a generated list) — so
 *      they are **pinned by `faq.test.tsx` against `TIERS` instead.** Change a tier's retention or
 *      the free allowance and that test fails, naming this file. That matters more here than
 *      anywhere else on the page: these answers are also emitted as machine-readable FAQPage JSON-LD,
 *      so a stale number doesn't just sit in the copy — it gets published to Google as a rich result
 *      while the tier card two sections up says something different.
 *   2. **Answer the awkward questions too.** A FAQ that only answers the flattering ones is
 *      marketing. The churn/pause behaviour and the absence of EU data residency are here because a
 *      buyer will find out anyway, and it's better they find out from us.
 *
 * `answer` is plain text on purpose: it is rendered into the DOM *and* into the FAQPage schema, and
 * Google requires those to match. Anything richer (a link) goes in `link`, which the schema ignores
 * and the reader still gets.
 */
export interface FaqItem {
  readonly question: string;
  readonly answer: string;
  readonly link?: { readonly href: string; readonly label: string };
  /**
   * Rendered `<details open>` — visible without a click.
   *
   * This is the MUST-DISCLOSE flag, not a styling preference. AGENTS.md requires pricing be
   * "disclosed **up front** … on the pricing page", and this page's job is to surprise nobody. Three
   * facts qualify, and they are exactly the ones a buyer would never think to click on *before*
   * paying: a delivery is a billed event; cancelling lands you paused; and dedup=off multiplies your
   * bill. Collapsed, they'd be a footnote — which is precisely what the disclosure rule forbids.
   *
   * `faq.test.tsx` pins which items carry this. Turning one off is a compliance change.
   */
  readonly discloses?: true;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "What counts as an event?",
    discloses: true,
    answer:
      "A request we capture is one event, and a delivery to a destination is one event. Forward an incoming webhook to three destinations and that's four events — one capture, three deliveries. We meter delivery because it costs us real money, and we'd rather charge for it honestly than lock it behind a paid tier.",
  },
  {
    question: "Are retries billed?",
    discloses: true,
    // The carve-outs are not marketing garnish — they're what the code actually does (migration 0055,
    // `delivery_attempts.billable`). Both used to be billed as full deliveries: `wbhk listen --forward`
    // billed every webhook twice, and a delivery the SSRF guard refused to send billed the same as a
    // 200. The page has to say so, or it's lying about the bill.
    //
    // NO MARKDOWN. `answer` is rendered as plain text into a <p> AND serialised into the FAQPage
    // JSON-LD — backticks here would show up literally in the prose and get published to Google as
    // part of the rich result.
    answer:
      "No. A delivery is billed once, when we first dispatch it, however many attempts it takes to land. If a destination is down and we retry, you pay nothing extra — our retry schedule is our cost. Also free: forwarding to your own machine with wbhk listen (your CLI makes that request, not us), a delivery we refuse to send because the URL resolves somewhere private, deduplicated duplicates, verification handshakes, and reading your own data.",
  },
  {
    question: "What happens when I hit my limit?",
    // AGENTS.md's promise is "disclosure + ALERTS + pause" — the pre-limit email is a load-bearing
    // third of it, so it can't sit behind a click either.
    discloses: true,
    answer:
      "Capture pauses within minutes of your limit. We email you before you reach your included volume — not after — and then stop capturing rather than silently run up a bill. Nothing is deleted, and nothing is charged that you didn't agree to.",
  },
  {
    question: "Can I keep going past my included volume?",
    answer: `Yes — turn on overage and we'll keep capturing at ${OVERAGE_PER_MILLION} per additional million events. It's off by default, because a surprise bill is worse than a pause. You can switch it on and off from the dashboard.`,
  },
  {
    question: "Is the free allowance really one-time?",
    answer:
      "Yes. The 5,000 events on the free plan are counted across the whole life of your organisation and never reset. It's a real trial, not a perpetual free tier — we'd rather say that plainly than dress up a monthly quota we don't offer.",
  },
  {
    question: "What happens if I cancel a paid plan?",
    discloses: true,
    answer:
      "You return to the free plan with that one-time allowance already spent — and because the free allowance never resets, capture pauses until you resubscribe. Your data stays exactly where it is, and resubscribing resumes capture immediately. This is the thing people are most often surprised by, so we say it before you pay rather than after.",
  },
  {
    question: "Do you gate features by plan?",
    answer:
      "No. Outbound delivery, replay, deduplication, signature verification, the CLI, the API, and the MCP server are on every plan, including the free one. Plans differ only by how many events they include and how long we keep them.",
  },
  {
    question: "How long do you keep my events?",
    answer:
      "7 days on Free, 30 days on Pro, 90 days on Scale, and up to a year on Enterprise. Reading your own data back never counts as a billable event.",
  },
  {
    question: "Why does turning deduplication off cost more?",
    discloses: true,
    answer:
      "Deduplication is on by default. If you turn it off for an endpoint, every retry a provider sends is a distinct captured request, and each one counts as an event. Providers retry a lot, so this can multiply your volume — that's the trade you're making when you disable it.",
  },
  {
    question: "Do you offer a DPA, and where is my data held?",
    answer:
      "Yes, there's a Data Processing Agreement, and you don't have to ask for it. Being straight with you: your data is currently hosted primarily in the United States and we do not offer EU data residency today. If that's a blocker for you, it's better you know now than three weeks into a security review.",
    link: { href: "/dpa", label: "Read the DPA" },
  },
];

/**
 * Build the FAQPage schema from the SAME array the DOM renders, so the markup can never say something
 * the page doesn't — both a Google policy requirement and the only way to keep two copies honest.
 */
function buildFaqSchema(items: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

function FaqEntry({ item }: { item: FaqItem }) {
  return (
    <details open={item.discloses} className="group border-b border-hairline last:border-0">
      <summary
        className={cn(
          focusRing,
          "flex cursor-pointer list-none items-center justify-between gap-4 rounded-control py-5 font-medium text-fg",
          // Safari draws its own disclosure triangle unless this is cleared.
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        {item.question}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </summary>
      {/* `faq-panel` animates the open transition in CSS (see marketing.css). Native <details> gives
          us the state machine for free; all we add is the motion.

          The MUST-disclose panels are deliberately NOT animated. They are open on load, so the
          keyframe would fade them in from `opacity: 0` — and a disclosure the constitution requires
          to be "up front" has no business being transparent, even for 280ms. Motion is for the panels
          a reader chooses to open. */}
      <div className={cn("pb-5", !item.discloses && "faq-panel")}>
        <p className="max-w-[68ch] leading-relaxed text-fg-secondary">{item.answer}</p>
        {item.link ? (
          <a
            href={item.link.href}
            className={cn(
              focusRing,
              "mt-3 inline-block rounded-control font-medium text-fg underline underline-offset-2 hover:text-fg-secondary",
            )}
          >
            {item.link.label}
          </a>
        ) : null}
      </div>
    </details>
  );
}

/**
 * A no-JavaScript accordion. `<details>`/`<summary>` gives keyboard operation, the expanded state,
 * and screen-reader semantics for free — so the page stays a server component with zero client
 * bundle, and the whole thing still works if the JS never arrives.
 */
export function Faq({
  items = FAQ_ITEMS,
  heading = "Frequently asked questions",
}: {
  /**
   * Which questions to answer. Each PAGE passes its own set: two pages emitting the SAME FAQPage
   * schema is duplicate structured data, and the questions a pricing page must answer are not the
   * ones a homepage must answer.
   */
  items?: readonly FaqItem[];
  heading?: string;
} = {}) {
  const faqSchema = buildFaqSchema(items);
  return (
    <section id="faq" aria-labelledby="faq-heading" className={cn(container, sectionPad)}>
      <script
        type="application/ld+json"
        // The payload is a compile-time constant from our own module — no user input reaches it. The
        // `<` escape is belt-and-braces for the one way a JSON-LD block can still go wrong: an answer
        // that ever contained the literal "</script>" would otherwise close this tag early and spill
        // the rest of the schema into the document as markup.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema).replace(/</g, "\\u003c") }}
      />
      <h2
        id="faq-heading"
        className="mb-8 text-center text-[clamp(24px,3vw,34px)] leading-tight font-semibold tracking-heading text-fg"
      >
        {heading}
      </h2>
      <div className="mx-auto max-w-[820px]">
        {items.map((item) => (
          <FaqEntry key={item.question} item={item} />
        ))}
      </div>
    </section>
  );
}
