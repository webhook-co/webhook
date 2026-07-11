import { cn } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { AnchoredHeading } from "@/components/marketing/anchored-heading";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { Nav } from "@/components/marketing/nav";
import { SUB_PROCESSORS_ANCHORS } from "@/app/legal-anchors";
import { focusRing } from "@/lib/styles";

export const metadata: Metadata = {
  // The root layout's title template already appends " — webhook.co".
  title: "Sub-processors",
  description:
    "The third-party infrastructure providers webhook.co uses to run the hosted service, what each handles, and where it's located.",
};

export default function SubProcessorsPage() {
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
        <LegalDoc title="Sub-processors" updated="11 July 2026">
          <blockquote>
            <strong>In short:</strong> these are the third-party infrastructure providers we rely on
            to run the hosted webhook.co service, what each one does, and the data it may handle. We
            update this page whenever the list changes.
          </blockquote>

          <p>
            A "sub-processor" is a third party we use to help provide the Service that may process
            personal data on our behalf. This page supports our{" "}
            <a href="/privacy">Privacy Policy</a> and, for business customers, our Data Processing
            Agreement. All of the providers below are engaged under data-protection terms (including
            Standard Contractual Clauses where personal data is transferred internationally).
          </p>

          <AnchoredHeading id={SUB_PROCESSORS_ANCHORS.currentSubProcessors}>
            Current sub-processors
          </AnchoredHeading>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th scope="col">Sub-processor</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Data it may process</th>
                  <th scope="col">Location</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Cloudflare, Inc.</th>
                  <td>
                    Platform compute, storage, and network — Workers, R2 (payload storage), KV,
                    Durable Objects, CDN/edge, Turnstile (login bot-protection), and CLI telemetry
                    (Analytics Engine).
                  </td>
                  <td>
                    Captured webhook payloads and headers; account and session data in transit;
                    minimal anonymous CLI telemetry.
                  </td>
                  <td>United States (global edge network)</td>
                </tr>
                <tr>
                  <th scope="row">Neon, Inc.</th>
                  <td>Managed PostgreSQL database for metadata and account data.</td>
                  <td>
                    Account and identity data, organisation data, event metadata, and session
                    records (including IP address and user-agent).
                  </td>
                  <td>United States</td>
                </tr>
                <tr>
                  <th scope="row">Amazon Web Services, Inc.</th>
                  <td>Key management (AWS KMS) for envelope-encrypted secrets.</td>
                  <td>Encryption keys only — never your webhook payloads or personal data.</td>
                  <td>United States</td>
                </tr>
                <tr>
                  <th scope="row">Stripe, Inc.</th>
                  <td>Payment processing and subscription billing.</td>
                  <td>
                    Billing and customer details. Stripe handles payment-card data directly; we
                    don't store full card numbers.
                  </td>
                  <td>United States</td>
                </tr>
                <tr>
                  <th scope="row">Resend</th>
                  <td>Transactional email — magic-link sign-in and service notifications.</td>
                  <td>Recipient email address and the content of those messages.</td>
                  <td>United States</td>
                </tr>
              </tbody>
            </table>
          </div>

          <AnchoredHeading id={SUB_PROCESSORS_ANCHORS.changes}>
            Changes to this list
          </AnchoredHeading>
          <p>
            When we add or replace a sub-processor, we'll update this page and its "Last updated"
            date above, and give <strong>at least 30 days' advance notice</strong> before the new
            sub-processor starts handling your data — so you have time to object. To get that notice
            by email, ask us at <a href="mailto:legal@webhook.co">legal@webhook.co</a> and we'll add
            you to the list.
          </p>
          <p>
            If you object on reasonable data-protection grounds within that window, your rights are
            set out in §6 of our <a href="/dpa">Data Processing Agreement</a>.
          </p>
        </LegalDoc>
      </main>
      <Footer />
    </>
  );
}
