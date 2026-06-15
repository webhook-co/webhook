import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";

import { Showcase } from "./showcase";
import { DeliveryPipeline } from "./visuals/delivery-pipeline";
import { ReplayTerminal } from "./visuals/replay-terminal";
import { TraceFlow } from "./visuals/trace-flow";
import { VerifyCard } from "./visuals/verify-card";

/**
 * The four product showcases, in document order. MCP & agents and ingestion & delivery aren't GA
 * yet, so they carry a "soon" marker; capture/replay is the live wedge; verification ships Stripe +
 * GitHub today (the copy says so).
 */
export function Showcases() {
  return (
    <>
      <Showcase
        id="mcp"
        eyebrow="mcp & agents"
        title="Turn a received webhook into an agent event"
        badge={{ label: "soon" }}
        body={
          <>
            MCP lets an agent call tools, but nothing has been able to <em>trigger</em> an agent
            from an incoming event. Now something can. A webhook arrives, gets verified,
            deduplicated, and made ready to replay, and your agent gets an event it can act on.
          </>
        }
        link={{ label: "Explore the MCP server", href: "#" }}
        visual={<TraceFlow />}
      />

      <Showcase
        id="capture"
        eyebrow="capture · inspect · replay"
        title="A permanent URL, full inspection, one-command replay"
        flip
        body="Point any provider at a URL that doesn't expire. Read every request in full — headers, body, and signature status — then forward any captured event to your local server with one command. Private by default: nothing is listed or shared unless you make it so."
        link={{ label: "See capture & replay", href: "#" }}
        visual={<ReplayTerminal />}
      />

      <Showcase
        id="delivery"
        eyebrow="ingestion & delivery"
        title="Received once, in order, never dropped"
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
