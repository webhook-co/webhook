import { pageMetadata } from "@/app/metadata";
import {
  ProductFeature,
  ProductFeatures,
  ProductShell,
} from "@/components/marketing/product-shell";
import { DeliveryPipeline } from "@/components/marketing/visuals/delivery-pipeline";
import { LINKS } from "@/lib/links";

export const metadata = pageMetadata({
  path: "/product/delivery",
  title: "Delivery",
  description:
    "Events delivered once, in order, retried over ~28 hours, and dead-lettered — never silently dropped. FIFO per endpoint, auto-disable on a broken target.",
});

export default function DeliveryPage() {
  return (
    <ProductShell
      eyebrow="delivery"
      title="Received once, in order, never silently dropped"
      lede="The same engine that captures your events runs the pipeline that moves them onward. Each endpoint keeps first-in-first-out order and its own isolation; failed deliveries retry, and what still can't land is dead-lettered, not dropped."
      path="/product/delivery"
      name="Delivery"
      visual={<DeliveryPipeline />}
      docsHref={LINKS.concepts.delivery}
      docsLabel="How delivery works"
    >
      <ProductFeatures>
        <ProductFeature id="fifo" heading="First-in-first-out, per endpoint">
          <p>
            Each endpoint gets its own Durable Object, which preserves the order events arrived in
            and isolates one endpoint&rsquo;s backlog from another&rsquo;s. A slow or failing
            destination slows only itself.
          </p>
        </ProductFeature>

        <ProductFeature id="retries" heading="Retries with backoff, then a dead letter">
          <p>
            A delivery is attempted up to eight times over roughly 28 hours &mdash; the first try,
            then seven retries with growing gaps: 5 seconds, 5 minutes, 30 minutes, on out to
            ten-hour waits. What still can&rsquo;t land is held in a dead-letter queue, not dropped,
            so you can fix the destination and replay. An endpoint that fails 20 times in a row is
            auto-disabled, so we stop hammering a target that&rsquo;s clearly down &mdash; and tell
            you.
          </p>
        </ProductFeature>

        <ProductFeature id="dedup" heading="Deduplicate by id, when you want it">
          <p>
            Providers resend. Turn on idempotency-key deduplication per endpoint and a repeated
            event is recognised and dropped before it reaches your handler twice. It&rsquo;s off by
            default &mdash; opt in per endpoint, because what counts as a duplicate is your call,
            not ours.
          </p>
        </ProductFeature>
      </ProductFeatures>
    </ProductShell>
  );
}
