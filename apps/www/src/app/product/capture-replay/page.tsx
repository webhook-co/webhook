import { pageMetadata } from "@/app/metadata";
import { Inspector } from "@/components/marketing/inspector/inspector";
import {
  ProductFeature,
  ProductFeatures,
  ProductShell,
} from "@/components/marketing/product-shell";
import { LINKS } from "@/lib/links";

export const metadata = pageMetadata({
  path: "/product/capture-replay",
  title: "Capture & replay",
  description:
    "A permanent ingest URL that captures every webhook — headers and body, exactly as received — before it acknowledges. Inspect it, then replay it to localhost.",
});

export default function CaptureReplayPage() {
  return (
    <ProductShell
      eyebrow="capture & replay"
      title="Capture every webhook. Replay it to localhost."
      lede="A permanent ingest URL that captures the full request — headers and body, exactly as received — before it acknowledges. Inspect it, then replay it to your machine with one command."
      path="/product/capture-replay"
      name="Capture & replay"
      visual={<Inspector />}
      docsHref={LINKS.concepts.captureAndReplay}
    >
      <ProductFeatures>
        <ProductFeature id="durable" heading="Durable before the acknowledgement">
          <p>
            The raw request is made durable <em>before</em> we return a 200 — not after. Most of the
            pipeline acks first and persists later; we don&rsquo;t. So a crash on a malformed
            payload, or a bad deploy on your side, is a replay, not a lost event.
          </p>
        </ProductFeature>

        <ProductFeature id="replay" heading="Replay to localhost, one command">
          <p>
            <code>wbhk listen --forward</code> points your public ingest URL at a port on your own
            machine, so real webhooks reach the code you&rsquo;re writing right now. One CLI, every
            provider &mdash; not one tool per provider. Replay a captured event to your laptop or
            back to production whenever you&rsquo;ve fixed the handler.
          </p>
        </ProductFeature>

        <ProductFeature id="accepts" heading="Accepts whatever a provider sends">
          <p>
            Providers don&rsquo;t agree on much. The ingest endpoint takes every HTTP method a
            webhook might arrive as, plus the <code>GET</code> verification handshake some providers
            require before they&rsquo;ll send anything &mdash; so you don&rsquo;t lose the first
            event to a setup check.
          </p>
        </ProductFeature>
      </ProductFeatures>
    </ProductShell>
  );
}
