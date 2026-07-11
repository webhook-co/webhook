import { cn } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { AnchoredHeading } from "@/components/marketing/anchored-heading";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { Nav } from "@/components/marketing/nav";
import { ACCEPTABLE_USE_ANCHORS } from "@/app/legal-anchors";
import { focusRing } from "@/lib/styles";

export const metadata: Metadata = {
  // The root layout's title template already appends " — webhook.co".
  title: "Acceptable Use Policy",
  description:
    "What you may and may not do with webhook.co — the rules that keep an arbitrary-ingest, outbound-delivery service from becoming attack infrastructure.",
};

// The AUP is the load-bearing policy for THIS product specifically: we accept arbitrary inbound data at a
// public URL and we will deliver it onward to a destination the customer chooses. That combination is
// genuinely useful and genuinely abusable, so the rules are stated plainly rather than buried in the ToS.
// Everything here must stay true to what the code actually does (no monitoring duty we don't perform, no
// certifications we don't hold).

export default function AcceptableUsePage() {
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
        <LegalDoc title="Acceptable Use Policy" updated="11 July 2026">
          <blockquote>
            <strong>In short (this summary isn&apos;t the policy, but it&apos;s honest):</strong>{" "}
            webhook.co takes in whatever you send to a URL and can deliver it onward to a
            destination you choose. That is exactly what makes it useful, and exactly what would
            make it good attack infrastructure — so: <strong>don&apos;t use it as any</strong>. Send
            data you&apos;re allowed to send. Deliver only to systems you own or are authorised to
            hit. No spam, no open relay, no using our outbound side to flood or probe someone else.
            We don&apos;t monitor your payloads, but if we learn you&apos;re doing this we will act.
          </blockquote>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.scope}>
            1. Who this applies to, and how it fits together
          </AnchoredHeading>
          <p>
            This Acceptable Use Policy (the &ldquo;AUP&rdquo;) applies to everyone who uses the
            hosted webhook.co service — account holders, their team members, and anyone acting
            through their credentials. It forms part of our <a href="/terms">Terms of Service</a>,
            and the definitions there apply here. If the two ever conflict on a use question, this
            policy wins.
          </p>
          <p>
            <strong>You are responsible for what happens under your account</strong>, including what
            your own users cause to be sent through it. Passing our rules along to the people you
            build for is on you.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.whyThisIsStrict}>
            2. Why this policy is strict
          </AnchoredHeading>
          <p>
            Most services only accept data from people who already have accounts. We don&apos;t: a
            webhook endpoint is a public URL that accepts arbitrary requests from anyone who knows
            it, and outbound delivery and replay will send data onward to a destination <em>you</em>{" "}
            nominate. Together that is a general-purpose relay, and a general-purpose relay in the
            wrong hands is a spam cannon, a scanner, or a command-and-control channel.
          </p>
          <p>
            We&apos;d rather say plainly what we won&apos;t host than pretend the risk isn&apos;t
            there.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.prohibitedUses}>
            3. What you must not do
          </AnchoredHeading>
          <p>
            <strong>Illegal or unauthorised data.</strong> Don&apos;t send, store, or process data
            that is illegal, that you have no lawful right to process, or that infringes someone
            else&apos;s rights. This includes child sexual abuse material, which we report to the
            authorities without notice to you and which results in immediate, permanent termination.
          </p>
          <p>
            <strong>Attack infrastructure.</strong> Don&apos;t use the Service to build or operate
            anything that attacks other systems. Specifically, don&apos;t:
          </p>
          <ul>
            <li>
              distribute malware, exploits, or ransomware, or run command-and-control through
              webhook endpoints, triggers, or delivery destinations;
            </li>
            <li>
              use outbound <strong>delivery or replay</strong> to flood, stress, scan, probe, or
              otherwise attack any host you don&apos;t own or aren&apos;t explicitly authorised to
              test — the destination being &ldquo;just a URL you configured&rdquo; is not
              authorisation;
            </li>
            <li>
              use the Service to reach systems you shouldn&apos;t be able to reach, or to disguise
              the origin of traffic;
            </li>
            <li>
              conduct security testing against anyone else&apos;s systems through us. Testing{" "}
              <em>your own</em> systems is fine and is a normal use of replay.
            </li>
          </ul>
          <p>
            <strong>Spam and unsolicited messaging.</strong> Don&apos;t use the Service to send
            unsolicited bulk messages, to operate an open relay, or to deliver anything a recipient
            has told you to stop sending.
          </p>
          <p>
            <strong>Phishing and deception.</strong> Don&apos;t use the Service to impersonate
            anyone, to harvest credentials, or to run any scheme whose point is to deceive.
          </p>
          <p>
            <strong>Our systems.</strong> Don&apos;t probe, disrupt, reverse-engineer, or attempt to
            defeat the security of the Service; don&apos;t try to reach data that isn&apos;t yours;
            don&apos;t deliberately overload us. If you find a vulnerability, tell us — see below.
          </p>
          <p>
            <strong>Plan and quota evasion.</strong> Don&apos;t resell or sublicense the Service
            outside your account, share it beyond your organisation, or create multiple accounts to
            get around plan limits or the one-time free allowance.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.regulatedData}>
            4. Regulated data — allowed, but at your risk
          </AnchoredHeading>
          <p>
            The Service is <strong>not designed for, and is not certified to handle,</strong>{" "}
            protected health information under HIPAA, full cardholder data under PCI DSS, or
            similarly regulated categories.{" "}
            <strong>We hold no SOC 2, ISO 27001, HIPAA, or PCI certification</strong>, and{" "}
            <strong>we do not sign BAAs</strong>.
          </p>
          <p>
            You may choose to send such data anyway — we won&apos;t inspect your payloads to stop
            you — but if you do, <strong>you do so entirely at your own risk</strong> and you are
            solely responsible for meeting whatever obligations apply to it. Bear in mind that the
            Service <strong>stores request bodies and headers as received, unredacted</strong>,
            because inspecting them is the product.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.monitoring}>
            5. Monitoring: what we do and don&apos;t do
          </AnchoredHeading>
          <p>
            <strong>We do not monitor the contents of your webhooks.</strong> We don&apos;t scan
            your payloads for policy violations, and nothing here should be read as a promise that
            we will. We rely on automated abuse signals, provider reports, and complaints.
          </p>
          <p>
            We reserve the <strong>right, but not the duty,</strong> to investigate a suspected
            violation and to look at the minimum data necessary to do so. That is a deliberate
            asymmetry: we want the ability to act on abuse without implying we are reading your data
            in the ordinary course. We are not.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.enforcement}>
            6. What happens if you break these rules
          </AnchoredHeading>
          <p>
            Depending on what we find, and how bad it is, we may: ask you to fix it; disable a
            specific endpoint, destination, or key; suspend your account; or terminate it.
            We&apos;ll usually contact you first and give you a chance to put it right.
          </p>
          <p>
            <strong>
              We may act immediately and without notice where the harm is serious or ongoing
            </strong>{" "}
            — an active attack, an ongoing spam run, illegal content, a threat to the Service or to
            other customers, or where the law requires it. In those cases we&apos;ll tell you what
            happened as soon as we reasonably can.
          </p>
          <p>
            Suspension or termination for a violation of this policy is{" "}
            <strong>not refundable</strong>, consistent with §6 of the <a href="/terms">Terms</a>.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.reportingAbuse}>
            7. Reporting abuse, and reporting vulnerabilities
          </AnchoredHeading>
          <p>
            If you believe someone is using webhook.co in breach of this policy, email{" "}
            <a href="mailto:abuse@webhook.co">abuse@webhook.co</a> with as much detail as you can
            give us — endpoint URLs, timestamps, and what you observed.
          </p>
          <p>
            If you&apos;ve found a security vulnerability in the Service, email{" "}
            <a href="mailto:security@webhook.co">security@webhook.co</a>. Report it to us first and
            give us a reasonable chance to fix it, don&apos;t access or alter data that isn&apos;t
            yours while investigating, and we won&apos;t pursue you for good-faith research that
            follows those rules.
          </p>

          <AnchoredHeading id={ACCEPTABLE_USE_ANCHORS.changes}>8. Changes</AnchoredHeading>
          <p>
            This is a young service and abuse patterns change, so we may update this policy. If we
            make a material change we&apos;ll update the date at the top and, for anything that
            would meaningfully restrict how you already use the Service, give you reasonable notice
            by email or in the dashboard.
          </p>
        </LegalDoc>
      </main>
      <Footer />
    </>
  );
}
