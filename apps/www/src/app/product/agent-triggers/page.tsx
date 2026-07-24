import { pageMetadata } from "@/app/metadata";
import {
  ProductFeature,
  ProductFeatures,
  ProductShell,
} from "@/components/marketing/product-shell";
import { AgentTriggerCard } from "@/components/marketing/visuals/agent-trigger-card";
import { LINKS } from "@/lib/links";

export const metadata = pageMetadata({
  path: "/product/agent-triggers",
  title: "Agent triggers",
  description:
    "Turn a webhook into an agent trigger: your agent subscribes to an endpoint and reads its events with a durable, at-least-once, cursor-acked call — captured even when the agent isn't running.",
});

export default function AgentTriggersPage() {
  return (
    <ProductShell
      eyebrow="agent triggers"
      title="Give your agents an event they can act on"
      lede="A webhook arrives whether or not your agent is awake. Subscribe to an endpoint and read what it captures with a durable, at-least-once, cursor-acked call — reachable from MCP today, and from the same contract on every other surface."
      path="/product/agent-triggers"
      name="Agent triggers"
      visual={<AgentTriggerCard />}
      docsHref={LINKS.mcp}
    >
      <ProductFeatures>
        <ProductFeature
          id="subscription"
          heading="A durable webhook subscription, not a polling loop you own"
        >
          <p>
            Your agent creates a trigger on an endpoint, then reads everything that endpoint
            captures with a cursor it acknowledges as it goes. Delivery is at-least-once: the event
            is durably captured the moment it arrives, whether or not your agent is up, and the
            cursor only advances past events you&rsquo;ve acked. You drive the read cadence; we hold
            the events and the position for you.
          </p>
        </ProductFeature>

        <ProductFeature id="vouched" heading="Verified before your agent ever sees it">
          <p>
            Events reach your agent having already passed the same edge verification everything else
            does &mdash; a forged event never surfaces to the agent, though the cursor still
            advances past it so it can&rsquo;t wedge the stream. Your agent acts on events
            you&rsquo;ve authenticated, not on raw untrusted input.
          </p>
        </ProductFeature>

        <ProductFeature id="one-contract" heading="One capability contract, four surfaces">
          <p>
            The MCP server is one binding over the same capability contract as the CLI, the API, and
            the dashboard &mdash; not a bolted-on side channel. And it&rsquo;s scoped: the agent can
            read your events, but the tools that redirect deliveries are deliberately withheld from
            the MCP surface, so an agent can be driven by your webhooks without being able to
            reroute them.
          </p>
        </ProductFeature>
      </ProductFeatures>
    </ProductShell>
  );
}
