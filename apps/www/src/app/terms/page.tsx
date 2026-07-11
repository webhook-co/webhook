import { cn } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { Nav } from "@/components/marketing/nav";
import { focusRing } from "@/lib/styles";

export const metadata: Metadata = {
  // The root layout's title template already appends " — webhook.co".
  title: "Terms of Service",
  description: "The terms that govern your use of the hosted webhook.co service.",
};

export default function TermsPage() {
  return (
    <>
      <a
        href="#main"
        className={cn(
          focusRing,
          "sr-only rounded-control bg-surface px-4 py-2 text-sm text-fg shadow-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100]",
        )}
      >
        Skip to content
      </a>
      <header>
        <AnnounceBar />
        <Nav />
      </header>
      <main id="main">
        <LegalDoc title="Terms of Service" updated="11 July 2026">
          <blockquote>
            <strong>In short (this summary isn't the contract, but it's honest):</strong> webhook.co
            is a tool for receiving, inspecting, verifying, replaying, and delivering webhooks,
            operated by a solo developer. <strong>You own the data you send through us</strong> — we
            only process it to run the service for you. Use it lawfully and don't turn it into
            attack or spam infrastructure. The service is provided <strong>"as is"</strong>, with no
            uptime guarantee on self-serve plans.{" "}
            <strong>If we ever owe you anything, it's capped</strong> at what you paid us in the
            last 3 months (or €100, whichever is greater). You can <strong>cancel anytime</strong>,
            and you keep the plan you've paid for until the end of that billing period. We don't
            refund automatically, but if something looks wrong on your bill, email us and we'll
            review it. These terms are governed by <strong>Portuguese law</strong>, and you keep
            every consumer right the law gives you.
          </blockquote>

          <h2>1. Who we are, and agreeing to these terms</h2>
          <p>
            webhook.co ("webhook.co", "we", "us", "our") is operated by{" "}
            <strong>Sourabh Choraria</strong>, a sole trader based in Porto, Portugal. You can reach
            us at <a href="mailto:sourabh@webhook.co">sourabh@webhook.co</a>.
          </p>
          <p>
            These Terms of Service (the "Terms") are a legal agreement between you (or the
            organisation you represent — "you", "your") and webhook.co, covering your use of our
            websites, APIs, command-line tools, dashboard, MCP server, and related services
            (together, the "Service"). By creating an account, or by accessing or using the Service,
            you agree to these Terms. If you're agreeing on behalf of an organisation, you confirm
            you're authorised to bind it.
          </p>
          <p>If you don't agree to these Terms, please don't use the Service.</p>

          <h2>2. What the Service does</h2>
          <p>
            webhook.co lets you create endpoints that receive incoming HTTP webhooks, inspect and
            verify them, store them so you can search and replay them, deliver them onward to
            destinations you configure, and trigger automated or agent workflows. The exact features
            available to you depend on your plan and may change over time (see §12).
          </p>
          <p>
            The Service inspects and stores the content of the webhooks you send through it — that's
            the core of what it does. It is <strong>not</strong> an end-to-end-encrypted or
            "zero-knowledge" service, and we don't claim to be: to inspect, verify, replay, and
            deliver your webhooks, we necessarily process their contents. See our{" "}
            <a href="/privacy">Privacy Policy</a> for how we handle that data.
          </p>
          <p>
            <strong>Scope — the hosted Service, not self-hosted software.</strong> These Terms (and
            our Privacy Policy) govern the <strong>hosted</strong> webhook.co Service that we
            operate at the webhook.co domains. Much of webhook.co is open source: the core platform
            and the official SDKs and CLI are published at{" "}
            <a href="https://github.com/webhook-co">github.com/webhook-co</a> under the{" "}
            <strong>Apache License 2.0</strong>, while certain enterprise and control-plane
            components are proprietary and separately licensed. If you obtain that software and run
            it yourself, your use of the software is governed by its applicable licence (for the
            open-source parts, Apache-2.0) — <strong>not</strong> by these Terms — and you alone are
            responsible for your own deployment and any data it processes. We don't provide support
            for, or assume any responsibility or liability for, self-hosted deployments.
          </p>

          <h2>3. Your account</h2>
          <p>
            You need an account to use most of the Service. You must provide accurate information,
            keep your credentials (including API keys and ingest tokens) secure, and you're
            responsible for everything that happens under your account. Tell us promptly at{" "}
            <a href="mailto:sourabh@webhook.co">sourabh@webhook.co</a> if you believe your account
            or a credential has been compromised.
          </p>
          <p>
            You must be at least 16 years old (or the age of digital consent in your country) and
            legally able to enter into these Terms. The Service is not directed to children.
          </p>

          <h2>4. Acceptable use</h2>
          <p>
            The full rules live in our <a href="/acceptable-use">Acceptable Use Policy</a>, which
            forms part of these Terms. The essentials are below.
          </p>
          <p>
            You may use the Service only for lawful purposes and in line with these Terms. Because
            webhook.co receives arbitrary data and can deliver it onward to destinations you choose,
            we're strict about misuse. You must <strong>not</strong>, and must not allow anyone else
            to:
          </p>
          <ul>
            <li>
              send, store, or transmit content that is illegal, or data you don't have the lawful
              right to process;
            </li>
            <li>
              use the Service to build or operate attack infrastructure — including malware,
              command-and-control, exploit delivery, phishing, or using outbound delivery/replay to
              flood, probe, or attack any system you don't own or aren't authorised to test;
            </li>
            <li>use the Service for unsolicited bulk messaging, spam, or as an open relay;</li>
            <li>
              resell, sublicense, or share the Service outside your account, or evade plan limits or
              the free allowance by creating multiple accounts;
            </li>
            <li>
              reverse engineer, disrupt, or probe the Service or its security, or attempt to access
              data that isn't yours.
            </li>
          </ul>
          <p>
            <strong>Regulated data.</strong> The Service is{" "}
            <strong>not designed for, and is not certified to handle,</strong> protected health
            information (PHI) under HIPAA, full payment-card data (PCI DSS), or similarly regulated
            categories. You may choose to send such data, but if you do,{" "}
            <strong>you do so at your own risk and are solely responsible</strong> for meeting any
            legal or contractual requirements that apply to it; we make no representations of
            suitability and provide no BAA or PCI attestation.
          </p>
          <p>
            We don't monitor your content, and we have no duty to. But we <strong>may</strong> —
            without any obligation to first review content — investigate suspected violations and
            act on abuse reports, including by removing content or suspending access (see §11).
          </p>

          <h2>5. Your data and content</h2>
          <p>
            <strong>You own your data.</strong> As between you and us, you retain all rights to the
            webhooks, payloads, and other content you send through or store on the Service ("Your
            Content"). You grant us a limited, worldwide, royalty-free licence to host, process,
            transmit, and display Your Content{" "}
            <strong>solely to provide, secure, support, and improve the Service for you</strong>,
            and as described in our <a href="/privacy">Privacy Policy</a>. We don't sell Your
            Content and we don't use it to build advertising profiles.
          </p>
          <p>
            You're responsible for Your Content and for having the rights and lawful basis to send
            it to us — including, where the webhooks you capture contain other people's personal
            data, for being the controller of that data (we act as your processor for it; see the
            Privacy Policy and our <a href="/dpa">Data Processing Agreement</a>).
          </p>

          <h2>6. Plans, billing, renewals, cancellation and refunds</h2>
          <p>
            <strong>Plans.</strong> We offer a free plan with a one-time usage allowance, paid
            self-serve plans, and enterprise plans arranged separately. Current prices and included
            volumes are shown at <a href="/pricing">webhook.co/pricing</a>. Prices are in{" "}
            <strong>euros (€)</strong> and exclusive of any taxes, which we'll add where required.
          </p>
          <p>
            <strong>How charging works.</strong> Paid plans have a fixed recurring plan fee, billed{" "}
            <strong>in advance</strong> for each billing period, plus usage above your plan's
            included volume ("overage"), which is <strong>metered and billed in arrears</strong> —
            meaning you're only ever charged for overage you actually use.
          </p>
          <p>
            <strong>Auto-renewal.</strong> Paid subscriptions <strong>renew automatically</strong>{" "}
            at the end of each billing period at the then-current price, until you cancel. By
            subscribing, you authorise us (through our payment processor, Stripe) to charge your
            payment method for each renewal. We'll make the renewal terms clear at checkout.
          </p>
          <p>
            <strong>Cancellation.</strong> You can cancel anytime from your account. Cancellation
            takes effect at the <strong>end of your current billing period</strong> — you keep the
            plan you've paid for until then, and you won't be charged again after that. You then
            return to the free tier; because the free allowance is one-time, capture stays paused if
            you've already spent it, until you resubscribe.
          </p>
          <p>
            <strong>Changing plans.</strong> <strong>Upgrades take effect immediately</strong>, so
            you get the extra volume the moment you need it; the difference for the rest of the
            period is prorated onto your next invoice.{" "}
            <strong>Downgrades take effect at the end of your current billing period</strong> — you
            keep the plan you paid for until it runs out, then move to the smaller one. A downgrade
            doesn't credit or refund the period you've already bought.
          </p>
          <p>
            <strong>Refunds.</strong> We <strong>don't refund automatically</strong>, and cancelling
            or downgrading mid-period doesn't trigger one — nothing is cut short, because you keep
            the plan you paid for until the period ends. Overage is billed in arrears, so you only
            ever pay for overage you actually used. The free plan involves no charge, so no refund.
          </p>
          <p>
            If you think you've been charged unfairly,{" "}
            <strong>get in touch and we'll look at it</strong>. Email{" "}
            <a href="mailto:support@webhook.co">support@webhook.co</a> and we'll review it{" "}
            <strong>case by case</strong> — we'd rather sort out a genuine problem than keep money
            we didn't earn. This is in addition to your statutory rights below, which we never ask
            you to waive.
          </p>
          <p>
            <strong>Your consumer rights.</strong> If you're a consumer in the EU/EEA, you have a
            statutory <strong>14-day right of withdrawal</strong>. Where you ask us to start
            providing the Service immediately, you may be asked to acknowledge that starting reduces
            or removes that right; even so, you'll never be charged for more than the Service
            actually supplied to you.{" "}
            <strong>
              Nothing in this section limits any non-waivable rights you have under Portuguese or EU
              consumer law.
            </strong>
          </p>
          <p>
            <strong>Non-payment.</strong> If a charge fails, we may retry, and we may suspend or
            downgrade paid features until payment is resolved.
          </p>

          <h2>7. Availability and support</h2>
          <p>
            We work hard to keep the Service running, but on the free and self-serve paid plans it's
            provided on a{" "}
            <strong>best-effort basis with no guaranteed uptime or service-level commitment</strong>
            . We may perform maintenance, and features may occasionally be unavailable. Formal
            service-level agreements (SLAs) and response-time commitments are available only under a
            separate enterprise agreement.
          </p>
          <p>
            Support on self-serve plans is best-effort by email at{" "}
            <a href="mailto:sourabh@webhook.co">sourabh@webhook.co</a>. We don't commit to specific
            response times except where a separate agreement says so.
          </p>

          <h2>8. The Service is provided "as is"</h2>
          <p>
            To the fullest extent permitted by law, the Service is provided{" "}
            <strong>"as is" and "as available"</strong>, without warranties of any kind, whether
            express or implied — including implied warranties of merchantability, fitness for a
            particular purpose, non-infringement, and any warranty that the Service will be
            uninterrupted, timely, secure, or error-free. Some warranties can't be excluded under
            applicable law; nothing here excludes them where that's the case.
          </p>

          <h2>9. Limitation of liability</h2>
          <p>
            Nothing in these Terms limits liability that can't be limited by law — including
            liability for death or personal injury caused by negligence, for fraud or fraudulent
            misrepresentation, for gross negligence or wilful misconduct, or any of your
            non-waivable rights as a consumer under Portuguese/EU law.
          </p>
          <p>Subject to that:</p>
          <ul>
            <li>
              <strong>No indirect damages.</strong> Neither party is liable for indirect,
              incidental, special, consequential, or exemplary damages, or for lost profits, lost
              revenue, lost business, or lost or corrupted data, even if advised of the possibility.
            </li>
            <li>
              <strong>Cap.</strong> Each party's total aggregate liability arising out of or
              relating to the Service and these Terms is limited to the{" "}
              <strong>
                greater of (a) the amount you paid us for the Service in the 3 months before the
                event giving rise to the claim, or (b) €100
              </strong>
              .
            </li>
          </ul>
          <p>
            These limits apply to the maximum extent permitted by applicable law and regardless of
            the theory of liability.
          </p>

          <h2>10. Indemnification</h2>
          <p>
            You'll defend and indemnify us against third-party claims, and the resulting losses,
            arising from Your Content, your use of the Service, or your breach of these Terms or of
            applicable law. We'll defend and indemnify you against third-party claims that the
            Service itself, as provided by us, infringes that third party's intellectual property
            rights. Each side must promptly notify the other of a claim and reasonably cooperate.
          </p>

          <h2>11. Suspension and termination</h2>
          <p>You may stop using the Service and close your account at any time.</p>
          <p>
            We may suspend or terminate your access — and, where the situation demands it,{" "}
            <strong>without prior notice</strong> — if you breach these Terms (including the
            acceptable-use rules in §4), if your use poses a security, legal, or operational risk to
            us or to others, or if required by law. Where practical and lawful, we'll give you
            notice and a chance to fix the problem first.
          </p>
          <p>
            On termination, your right to use the Service ends. We'll handle your data as described
            in our <a href="/privacy">Privacy Policy</a>, including honouring deletion and erasure
            requests.
          </p>

          <h2>12. Changes to the Service and to these Terms</h2>
          <p>
            We may change, add, or remove features of the Service over time. We may also update
            these Terms. For <strong>material</strong> changes to these Terms, we'll give reasonable
            advance notice by email or in-app, and post the updated "Last updated" date. Changes
            aren't retroactive, and if you've signed a separate enterprise agreement, that
            agreement's change terms control for you. If you keep using the Service after a change
            takes effect, you accept the updated Terms; if you don't agree, you can stop using the
            Service and cancel.
          </p>

          <h2>13. Intellectual property</h2>
          <p>
            We (and our licensors) own the Service, including its software, design, and trademarks.
            We grant you a limited, non-exclusive, non-transferable right to use the Service under
            these Terms. You get no rights to our software or marks beyond that. The Service
            incorporates both open-source components (licensed to you under their own licences — see
            §2) and proprietary components; nothing in these Terms limits your rights under an
            applicable open-source licence, and no such licence grants you rights in the
            "webhook.co" or "wbhk" names or logos. If you send us feedback or suggestions, you grant
            us a perpetual, royalty-free right to use them without obligation to you.
          </p>

          <h2>14. Governing law and disputes</h2>
          <p>
            These Terms are governed by the <strong>laws of Portugal</strong>, without regard to
            conflict-of-laws rules. Any dispute will be subject to the{" "}
            <strong>courts of Portugal</strong> — but if you're a consumer, this doesn't deprive you
            of the protection of the mandatory laws of your country of residence or of your right to
            bring proceedings there where the law allows.{" "}
            <strong>We don't require arbitration.</strong> EU consumers may also use the European
            Commission's Online Dispute Resolution platform.
          </p>

          <h2>15. Enterprise and separate agreements</h2>
          <p>
            If you and we sign a separate written agreement for the Service (for example, an
            enterprise order form or master services agreement, with its own SLA, Data Processing
            Agreement, or negotiated terms), that agreement governs to the extent it conflicts with
            these Terms for that use.
          </p>

          <h2>16. General</h2>
          <p>
            These Terms (plus any policies they link to and any separate agreement you've signed)
            are the entire agreement between us about the Service. If a provision is found
            unenforceable, the rest stays in effect. Our not enforcing a right isn't a waiver of it.
            You may not assign these Terms without our consent; we may assign them to a successor to
            our business. Notices to you may be given by email or in-app; notices to us go to{" "}
            <a href="mailto:sourabh@webhook.co">sourabh@webhook.co</a>.
          </p>
          <p>
            <strong>Contact:</strong> Sourabh Choraria (webhook.co) —{" "}
            <a href="mailto:sourabh@webhook.co">sourabh@webhook.co</a>
          </p>
        </LegalDoc>
      </main>
      <Footer />
    </>
  );
}
