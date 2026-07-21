import { pageMetadata } from "@/app/metadata";
import {
  ProductFeature,
  ProductFeatures,
  ProductShell,
} from "@/components/marketing/product-shell";
import { ProviderWall } from "@/components/marketing/provider-wall";
import { VerifyCard } from "@/components/marketing/visuals/verify-card";
import { LINKS } from "@/lib/links";
import { proseLink } from "@/lib/styles";

export const metadata = pageMetadata({
  path: "/product/verification",
  title: "Verification",
  // "checked", not "verified" — ~14 of the 141 only offer a shared token and land on the weaker
  // "authenticated" state, so a standalone SERP snippet must not imply all 141 are cryptographically
  // verified (the page body makes the four-state distinction; the description can't rely on it).
  description:
    "141 providers checked at the edge. Every event lands in one of four states, and when a signature fails we name the likely reason — one of eleven codes — with the fix.",
});

export default function VerificationPage() {
  return (
    <ProductShell
      eyebrow="verification"
      title="When a signature fails, you'll know why"
      lede="141 providers, checked at the edge. Every event lands in one of four states — and when a signature doesn't match, we name the likely reason, one of eleven codes, with the fix, instead of a bare match/no-match."
      path="/product/verification"
      name="Verification"
      visual={<VerifyCard />}
      docsHref={LINKS.concepts.verification}
      docsLabel="Read the verification guide"
    >
      <ProductFeatures>
        <ProductFeature id="four-states" heading="Verified is not a boolean">
          <p>
            An event is <strong>verified</strong>, <strong>authenticated</strong>,{" "}
            <strong>failed</strong>, or <strong>unattempted</strong> &mdash; four states, not two.
            Roughly 14 of the 141 providers only offer a shared token rather than a real signature,
            so those land on the weaker <strong>authenticated</strong>, and we tell you that plainly
            rather than calling it verified.
          </p>
        </ProductFeature>

        <ProductFeature id="eleven-reasons" heading="Eleven named reasons, each with the fix">
          <p>
            Wrong secret. Raw body modified. A proxy mutated the bytes. Timestamp outside the
            window. No matching key. When verification fails, the edge names the likely cause in
            plain language &mdash; not &ldquo;no signatures found matching the expected
            signature.&rdquo; The one you hit most, <code>RAW_BODY_MODIFIED</code>, usually means a
            framework re-serialized the body before you verified it; the message says so. You can
            see it for yourself in the{" "}
            <a href={LINKS.verify} className={proseLink}>
              signature verifier
            </a>{" "}
            &mdash; it runs this same engine in your browser and names the reason.
          </p>
        </ProductFeature>

        <ProductFeature
          id="never-resign"
          heading="We never re-sign an event we couldn't authenticate"
        >
          <p>
            A webhook that fails verification is never delivered onward. One that was never checked
            is delivered, but never signed. Your app trusts our signature, so our signature has to
            mean something. Verification and signing both follow{" "}
            <a href={LINKS.standardWebhooks} className={proseLink}>
              Standard Webhooks
            </a>
            , for receiving and sending.
          </p>
        </ProductFeature>
      </ProductFeatures>

      {/* The claim used to be a CARD that said "141 providers in one open registry". Showing the 141
          is a better argument than asserting them — so the full registry lives here, on the page it
          is actually about. The homepage shows a recognisable few and links through. */}
      <ProviderWall />
    </ProductShell>
  );
}
