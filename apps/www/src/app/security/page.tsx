import { pageMetadata } from "@/app/metadata";
import {
  ProductFeature,
  ProductFeatures,
  ProductShell,
} from "@/components/marketing/product-shell";
import { LINKS } from "@/lib/links";
import { proseLink } from "@/lib/styles";

export const metadata = pageMetadata({
  path: "/security",
  title: "Security",
  description:
    "Private by default. Tenant isolation enforced in the database by row-level security, secrets in a KMS, a tamper-evident audit log, and an open-source core you can read.",
});

export default function SecurityPage() {
  return (
    <ProductShell
      eyebrow="security"
      title="Private by default, open at the core"
      lede="Nothing you capture is listed or shared unless you make it so. Tenant isolation is enforced in the database, secrets live in a KMS, and the audit log is tamper-evident. The parts that verify and move your events are open source."
      path="/security"
      name="Security"
      docsHref={LINKS.concepts.security}
      docsLabel="Read the security docs"
      // A trust page, not a pitch. Someone here is asking "can I rely on this" — "Get started" answers
      // a question they haven't asked yet. The closing CTA still carries the sign-up.
      showStartCta={false}
    >
      <ProductFeatures>
        <ProductFeature id="private" heading="Private by default">
          <p>
            Nothing is public, listed, or shared unless you explicitly make it so. There&rsquo;s no
            directory of ingest URLs, no shared inbox, no default that leaks. The safe posture is
            the one you get without configuring anything.
          </p>
        </ProductFeature>

        <ProductFeature id="rls" heading="Tenant isolation by row-level security">
          <p>
            One organisation&rsquo;s data is unreachable from another&rsquo;s, and that boundary is
            enforced by Postgres row-level security &mdash; in the database, under every query
            &mdash; not only by application code that has to remember to filter. A missed{" "}
            <code>WHERE</code> clause can&rsquo;t cross tenants.
          </p>
        </ProductFeature>

        <ProductFeature id="kms" heading="Secrets in a KMS, encrypted in transit and at rest">
          <p>
            Provider secrets and signing keys are wrapped with a key-management service using
            envelope encryption, bound to the tenant they belong to &mdash; a secret won&rsquo;t
            unwrap for the wrong org. Nothing sensitive sits in plaintext config or source.
          </p>
        </ProductFeature>

        <ProductFeature id="audit" heading="A tamper-evident audit log">
          <p>
            Security-relevant actions are written to an append-only, hash-chained log, so a later
            edit to history is detectable rather than silent. It&rsquo;s the record you want to have
            kept before you need it.
          </p>
        </ProductFeature>

        {/* The only card about OUTBOUND risk — the rest of this page is about what we hold. Everything
            below is shipped and verifiable in the open-source engine (delivery-dispatcher.ts): the
            engine is the single egress chokepoint, every resolved address is validated at connect
            time, the guard fails closed, redirects are not followed blindly, and headers are filtered. */}
        <ProductFeature id="egress" heading="Your endpoints can't be turned into a probe">
          <p>
            Replay and delivery send events to a URL <em>you</em> register &mdash; which is exactly
            the shape of a request-forgery bug if nobody is watching. So all outbound traffic leaves
            through one chokepoint in the engine: every address a destination resolves to is checked
            before the connection is made, not just the hostname you typed, and a redirect
            can&rsquo;t quietly move the target afterwards. If the check can&rsquo;t be completed,
            the delivery doesn&rsquo;t go &mdash; it fails closed.
          </p>
        </ProductFeature>

        <ProductFeature id="open" heading="Open source, so you can check">
          <p>
            The core engine, the CLI, the MCP server, and the signing library are open source under
            the Apache License 2.0 at{" "}
            <a href={LINKS.openSource} className={proseLink}>
              github.com/webhook-co
            </a>
            . You can read exactly how a signature is verified and how a tenant is isolated, rather
            than taking our word for it.
          </p>
        </ProductFeature>
      </ProductFeatures>
    </ProductShell>
  );
}
