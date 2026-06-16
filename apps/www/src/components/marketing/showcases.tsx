import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";

import { Showcase } from "./showcase";
import { DeliveryPipeline } from "./visuals/delivery-pipeline";
import { VerifyCard } from "./visuals/verify-card";

/**
 * The two product showcases, in document order. Ingestion & delivery isn't GA yet, so it carries a
 * "soon" marker; verification ships today (the copy names the providers).
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
        badge={{ label: "soon" }}
        body="The same engine that captures your events runs the pipeline that moves them. Events are deduplicated by id, acknowledged fast, then processed. Each endpoint keeps first-in-first-out ordering and its own isolation. Failed deliveries retry with backoff; what still can't land is held in a dead-letter queue, not dropped."
        link={{ label: "How delivery works", href: "#" }}
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
            and name the actual cause, in plain language, with the fix attached — Stripe &amp;
            GitHub today, more soon. Verification is{" "}
            <a
              href="https://www.standardwebhooks.com/"
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
        link={{ label: "Read the verification guide", href: "#" }}
        visual={<VerifyCard />}
      />
    </>
  );
}
