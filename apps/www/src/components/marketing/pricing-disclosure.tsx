import { cn } from "@webhook-co/ui";

import { container } from "@/lib/styles";

/**
 * The billing disclosure, in plain view on the pricing page.
 *
 * WHY IT EXISTS AS ITS OWN BLOCK. AGENTS.md makes this a non-negotiable: the billable unit is
 * "stated up front... at endpoint creation and on the pricing page", and the soft cap "pauses rather
 * than surprises". Until now the only place that promise appeared on this page was inside FAQ entries
 * that were forced OPEN for exactly that reason. Collapsing the FAQ by default (which reads better,
 * and is what a reader expects of an accordion) would have silently deleted the disclosure.
 *
 * So it moves here, where it should have been: visible, unconditional, and impossible to collapse.
 * `pricing-disclosure.test.tsx` pins that it is NOT inside a <details>, and that it still states the
 * billable unit, the pre-limit alert, and the pause — so nobody can quietly tuck it back behind a
 * click. Everything here is what the code actually does; the FAQ still carries the detail.
 */
/**
 * THE CONTRACT. The facts AGENTS.md / ADR-0004 / ADR-0104 require the pricing page to state up front,
 * as the strings a reader must actually be able to read. Both the unit test and the real-browser a11y
 * test iterate this — so the set is derived from one place and cannot drift: add a sixth obligation
 * here and every guard starts covering it, instead of silently continuing to look thorough.
 */
export const MUST_DISCLOSE_FACTS: readonly { readonly what: string; readonly needle: RegExp }[] = [
  { what: "a delivery is a billed event", needle: /a delivery to a destination is one event/i },
  { what: "the pre-limit alert", needle: /email you/i },
  { what: "the cap pauses rather than bills", needle: /capture pauses/i },
  {
    what: "dedup=off costs more",
    needle: /every retry a provider sends is a distinct captured request/i,
  },
  { what: "forwarding to your own machine is free", needle: /forwarding to your own machine/i },
  { what: "cancelling pauses, it does not delete", needle: /cancelling pauses capture/i },
];

export function PricingDisclosure() {
  return (
    <section
      aria-labelledby="what-you-pay-for"
      className={cn(container, "pb-[clamp(28px,4vw,44px)]")}
    >
      <div className="mx-auto max-w-[820px] rounded-card border border-hairline bg-surface p-6">
        <h2
          id="what-you-pay-for"
          className="mb-3 text-lg font-semibold tracking-heading text-fg sm:text-xl"
        >
          What you pay for, before you sign up
        </h2>
        <ul className="flex flex-col gap-2.5 text-sm text-pretty text-fg-secondary">
          <li>
            <span className="font-medium text-fg">One event = one captured request.</span> A request
            we capture is one event, and a delivery to a destination is one event. Forward an
            incoming webhook to three destinations and that&rsquo;s four events &mdash; one capture,
            three deliveries.
          </li>
          <li>
            <span className="font-medium text-fg">Retries are not a second event.</span> A delivery
            and its retries bill once. A request we refuse to send &mdash; a blocked destination
            &mdash; isn&rsquo;t billed at all.
          </li>
          <li>
            <span className="font-medium text-fg">We pause; we don&rsquo;t surprise you.</span> We
            email you <em>before</em> you reach your included volume, and then capture pauses within
            minutes rather than running up a bill. Overage is off by default and you turn it on
            yourself.
          </li>
          <li>
            <span className="font-medium text-fg">
              Turning deduplication off costs more, on purpose.
            </span>{" "}
            With it on, a provider&rsquo;s retries of the same webhook are one captured request.
            With it off, every retry a provider sends is a distinct captured request &mdash; and
            billed as one. It is on by default.
          </li>
          <li>
            <span className="font-medium text-fg">Replaying to your own machine is free.</span>{" "}
            Forwarding to your own machine with the CLI is not a delivery: your CLI makes that
            request, not us, so there is nothing for us to bill.
          </li>
          <li>
            <span className="font-medium text-fg">Nothing is deleted when you stop paying.</span>{" "}
            Cancelling pauses capture until you resubscribe; it doesn&rsquo;t erase what you already
            have. The free allowance is one-time and never resets.
          </li>
        </ul>
      </div>
    </section>
  );
}
