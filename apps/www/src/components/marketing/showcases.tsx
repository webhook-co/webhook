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
        body="The same engine that captures your events runs the pipeline that moves them. Events are deduplicated by id, acknowledged fast, then processed. Each endpoint keeps first-in-first-out ordering and its own isolation. Failed deliveries retry with backoff; what still can't land is held in a dead-letter queue, not dropped."
        link={{ label: "How delivery works", href: LINKS.concepts.delivery }}
        visual={<DeliveryPipeline />}
      />

      <Showcase
        id="verification"
        eyebrow="verification"
        title="When a signature fails, you'll know why"
        flip
        body={
          <>
            Most tooling tells you a signature didn't match and stops there. We verify at the edge
            and name the actual cause, in plain language, with the fix attached — across 142
            providers, from HMAC to Ed25519. Verification is{" "}
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
