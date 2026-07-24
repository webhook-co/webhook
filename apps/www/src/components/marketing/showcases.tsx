import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";

import { LINKS } from "@/lib/links";
import { Showcase } from "./showcase";
import { DeliveryPipeline } from "./visuals/delivery-pipeline";
import { VerifyCard } from "./visuals/verify-card";

/**
 * The two product showcases, in document order.
 *
 * Ingestion & delivery carried a "soon" badge long after it shipped — while /pricing said "every plan
 * includes outbound delivery" and the FAQ explained that a delivery IS a billed event. The homepage
 * was telling people the feature wasn't ready while the pricing page charged them for it. Both
 * showcases describe things that work today.
 */
export function Showcases() {
  return (
    <>
      <Showcase
        id="delivery"
        eyebrow="ingestion & delivery"
        title={
          <>
            Received once, in order, never <em className="italic">silently</em> dropped
          </>
        }
        body="The same engine that captures your events runs the pipeline that moves them. Events are acknowledged fast, then processed in first-in-first-out order per endpoint, each isolated from the rest. Failed deliveries retry with backoff; what still can't land is held in a dead-letter queue, not dropped. Turn on dedup by id when a provider resends."
        link={{ label: "How delivery works", href: LINKS.concepts.delivery }}
        visual={<DeliveryPipeline />}
      />

      <Showcase
        id="verification"
        eyebrow="the provider tax"
        title="Every provider you add is a new way to fail silently"
        flip
        body={
          <>
            New scheme, new secret, new encoding, new way to fail. We check every event at the edge
            across 144 providers, sort it into one of four states, and when a signature
            doesn&rsquo;t match we name the likely cause &mdash; wrong secret, mutated body, stale
            timestamp &mdash; with the fix, instead of the bare &ldquo;no signatures found&rdquo;
            most tooling stops at. It&rsquo;s{" "}
            <a
              href={LINKS.standardWebhooks}
              className={cn(
                focusRing,
                "rounded-control border-b border-strong font-medium text-fg transition-colors hover:border-fg",
              )}
            >
              Standard Webhooks
            </a>{" "}
            compliant, for both sending and receiving.
          </>
        }
        link={{ label: "Read the verification guide", href: LINKS.concepts.verification }}
        visual={<VerifyCard />}
      />
    </>
  );
}
