import { cn } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { AnchoredHeading } from "@/components/marketing/anchored-heading";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { Nav } from "@/components/marketing/nav";
import { DPA_ANCHORS } from "@/app/legal-anchors";
import { focusRing } from "@/lib/styles";

export const metadata: Metadata = {
  // The root layout's title template already appends " — webhook.co".
  title: "Data Processing Agreement",
  description:
    "The GDPR Article 28 terms under which webhook.co processes the personal data contained in the webhooks you capture — including the security measures, sub-processors, and SCCs.",
};

// The DPA (GDPR Art 28). EVERY security claim below has to match what the code actually does — an
// enterprise buyer will read this line by line, and a promise we don't keep is worse than an absent one.
// Deliberately NOT claimed, because they aren't true: SOC 2 / ISO / HIPAA / PCI certification, EU data
// residency, end-to-end encryption, payload redaction, or a KMS holding customer payloads (KMS holds our
// SECRETS — provider secrets, signing keys, the sealed ingest token — not your webhook bodies).

export default function DpaPage() {
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
        <LegalDoc title="Data Processing Agreement" updated="11 July 2026">
          <blockquote>
            <strong>In short (this summary isn&apos;t the agreement, but it&apos;s honest):</strong>{" "}
            the webhooks you capture may contain other people&apos;s personal data. For that data{" "}
            <strong>you are the controller and we are your processor</strong>: we only handle it to
            run the Service for you, on your instructions. This document is the GDPR Article 28
            contract that says so — what we do with it, how we protect it, who else touches it, how
            it leaves the EU, and what happens when you leave. It applies automatically when you use
            the Service; you don&apos;t need to sign anything.
          </blockquote>

          <AnchoredHeading id={DPA_ANCHORS.scope}>
            1. What this is, and when it applies
          </AnchoredHeading>
          <p>
            This Data Processing Agreement (&ldquo;<strong>DPA</strong>&rdquo;) forms part of the{" "}
            <a href="/terms">Terms of Service</a> between you (&ldquo;<strong>Controller</strong>
            &rdquo;) and webhook.co, operated by <strong>Sourabh Choraria</strong>, a sole trader
            based in Porto, Portugal (&ldquo;<strong>Processor</strong>&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;).
          </p>
          <p>
            It applies whenever we process <strong>personal data</strong> (as defined in the{" "}
            <strong>GDPR</strong>, and in the UK GDPR where relevant) on your behalf. It is{" "}
            <strong>incorporated automatically</strong> — using the Service is acceptance, and you
            do not need to sign or return a copy. If your procurement process requires a
            countersignature, email <a href="mailto:legal@webhook.co">legal@webhook.co</a>.
          </p>
          <p>
            Terms defined in the GDPR (controller, processor, personal data, processing, data
            subject, personal data breach, supervisory authority) have the same meaning here.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.controllerAndProcessor}>
            2. The two roles — and which data this covers
          </AnchoredHeading>
          <ul>
            <li>
              <strong>The webhooks you capture — we are your processor.</strong> Request bodies,
              headers, and the verification and delivery metadata around them may contain personal
              data belonging to <em>your</em> users or to third parties. You decide what to send
              through us and why. <strong>This DPA governs that data.</strong>
            </li>
            <li>
              <strong>Your account data — we are the controller.</strong> Your name, email, sign-in
              identity, organisation, billing details, and usage counts. We decide how to handle
              that, and our <a href="/privacy">Privacy Policy</a> — not this DPA — governs it.
            </li>
          </ul>

          <AnchoredHeading id={DPA_ANCHORS.processingDetails}>
            3. Scope of the processing (Article 28(3))
          </AnchoredHeading>
          <ul>
            <li>
              <strong>Subject matter:</strong> providing the hosted webhook.co Service — receiving,
              verifying, storing, inspecting, searching, replaying, and delivering the webhooks you
              capture, and triggering the automated or agent workflows you configure.
            </li>
            <li>
              <strong>Duration:</strong> for as long as your account is open, and thereafter as set
              out in §10 (return and deletion).
            </li>
            <li>
              <strong>Nature and purpose:</strong> receipt, signature verification, deduplication,
              storage, retrieval, retry, replay, onward delivery, and deletion — all of it
              automated, and all of it in order to run the Service for you.
            </li>
            <li>
              <strong>Types of personal data:</strong>{" "}
              <em>whatever your webhooks happen to contain.</em> We do not choose it and cannot
              predict it. In practice it is commonly identifiers, names, email addresses, postal and
              IP addresses, transaction and order details, and any other field the sending system
              puts in the payload.
            </li>
            <li>
              <strong>Categories of data subjects:</strong> your users, customers, employees, and
              anyone else whose data appears in the webhooks you route through us.
            </li>
            <li>
              <strong>Special categories:</strong> the Service is not designed for special-category
              data (Article 9) and we do not solicit it. If you send it, you do so on your own
              assessment and at your own risk — see §4 of our{" "}
              <a href="/acceptable-use">Acceptable Use Policy</a>.
            </li>
          </ul>

          <AnchoredHeading id={DPA_ANCHORS.ourObligations}>4. Our obligations</AnchoredHeading>
          <p>
            <strong>We process only on your documented instructions.</strong> Your instructions are:
            this DPA, the Terms, and the configuration you set through the dashboard, API, CLI, or
            MCP server. We will not process the data for any other purpose — in particular we{" "}
            <strong>
              do not sell it, do not use it for advertising, and do not use it to train
              machine-learning models
            </strong>
            .
          </p>
          <p>
            If we are required by EU or Member State law to process it otherwise, we will tell you
            before doing so unless that law forbids us from telling you.
          </p>
          <p>
            <strong>If we think an instruction is unlawful</strong>, we&apos;ll tell you rather than
            quietly comply.
          </p>
          <p>
            <strong>Confidentiality.</strong> Access is limited to people who need it to run the
            Service and who are bound by confidentiality. Today that is a very short list:
            webhook.co is operated by one person.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.securityMeasures}>
            5. Security measures (Article 32)
          </AnchoredHeading>
          <p>
            These are the measures actually in place. We&apos;ve deliberately kept this list to what
            is true, rather than what sounds reassuring.
          </p>
          <ul>
            <li>
              <strong>Encryption in transit:</strong> TLS on every external interface — ingestion,
              API, dashboard, and outbound delivery.
            </li>
            <li>
              <strong>Encryption at rest:</strong> payload bodies and metadata are stored encrypted
              at rest by our infrastructure providers.{" "}
              <strong>
                This is provider-managed encryption, not a customer-managed key over your payloads
              </strong>{" "}
              — we don&apos;t claim otherwise. Our own high-value secrets (provider signing secrets,
              your signing keys, sealed ingest tokens) are additionally protected by a{" "}
              <strong>key management service</strong>.
            </li>
            <li>
              <strong>Tenant isolation:</strong> customer data is separated at the database level by{" "}
              <strong>row-level security</strong>, enforced by the database rather than by
              application code, so a bug in a query cannot return another tenant&apos;s rows. Stored
              payload objects are additionally fenced to the owning organisation.
            </li>
            <li>
              <strong>Signature verification:</strong> inbound webhooks can be cryptographically
              verified against the sending provider&apos;s signature, and outbound deliveries are
              signed following the <strong>Standard Webhooks</strong> specification.
            </li>
            <li>
              <strong>Credential handling:</strong> API keys are stored only as one-way hashes. We
              never store passwords — sign-in is via Google, GitHub, or an emailed link.
            </li>
            <li>
              <strong>Audit logging:</strong> security-relevant actions are written to an
              append-only, hash-chained audit log, so tampering with the record is detectable.
            </li>
            <li>
              <strong>Automated deletion:</strong> captured webhooks expire automatically at the end
              of your plan&apos;s retention window, and deletion removes the stored payload body,
              not just the index entry.
            </li>
            <li>
              <strong>Egress protection:</strong> outbound delivery and replay refuse to send to
              private and internal network ranges, so the Service cannot be turned into a probe of
              internal infrastructure.
            </li>
            <li>
              <strong>Resilience:</strong> the Service runs on managed, redundant infrastructure
              with automated retries and durable queues. Data is backed up; residual copies in
              backups age out on the normal rotation cycle.
            </li>
          </ul>
          <p>
            <strong>What we do not have, and won&apos;t pretend to:</strong> we hold{" "}
            <strong>no SOC 2, ISO 27001, HIPAA, or PCI certification</strong>; we do not offer{" "}
            <strong>EU-only data residency</strong> (see §7); we are not end-to-end encrypted; and
            we <strong>store request bodies and headers unredacted</strong>, because inspecting them
            is the product. If your risk assessment needs any of those, we are not the right
            processor for that workload yet — and we&apos;d rather tell you now than in a
            questionnaire later.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.subProcessors}>
            6. Sub-processors (Article 28(2) and (4))
          </AnchoredHeading>
          <p>
            You give us <strong>general written authorisation</strong> to engage sub-processors to
            help run the Service. The current list — who they are, what each one handles, and where
            they are — is maintained at <a href="/sub-processors">webhook.co/sub-processors</a>.
          </p>
          <p>
            We impose data-protection obligations on each sub-processor that are no less protective
            than those in this DPA, and{" "}
            <strong>we remain fully liable to you for what they do</strong>.
          </p>
          <p>
            <strong>Changes.</strong> Before we add or replace a sub-processor we will update that
            page and give you at least <strong>30 days&apos; notice</strong>. To receive that notice
            by email, ask us at <a href="mailto:legal@webhook.co">legal@webhook.co</a> and
            we&apos;ll add you to the list. If you reasonably object on data-protection grounds
            within that window, tell us and we&apos;ll try to find a way through; if we can&apos;t,
            you may terminate the affected Service and we&apos;ll refund any prepaid, unused fees
            for it (an exception to the no-automatic-refunds rule in §6 of the{" "}
            <a href="/terms">Terms</a>).
          </p>

          <AnchoredHeading id={DPA_ANCHORS.internationalTransfers}>
            7. International transfers
          </AnchoredHeading>
          <p>
            <strong>
              Your data is currently hosted primarily in the United States. We do not offer EU data
              residency.
            </strong>{" "}
            Say so plainly, because it&apos;s the first thing an EU buyer needs to know.
          </p>
          <p>
            Where we transfer personal data out of the EEA, UK, or Switzerland, we rely on the{" "}
            <strong>European Commission&apos;s Standard Contractual Clauses</strong> (Decision
            2021/914), which are <strong>incorporated into this DPA by reference</strong>:
          </p>
          <ul>
            <li>
              <strong>Module Two</strong> (controller to processor) applies between you and us, with
              you as data exporter and us as data importer;
            </li>
            <li>
              <strong>Module Three</strong> (processor to processor) applies where you are yourself
              a processor for someone else;
            </li>
            <li>
              docking clause: applicable. Clause 9: <strong>Option 2</strong>, general written
              authorisation, with the 30-day notice period in §6 above. Clause 17: governed by the
              law of <strong>Portugal</strong>. Clause 18: the courts of <strong>Portugal</strong>.
              Annexes I, II, and III are supplied by §§3, 5, and 6 of this DPA and by the
              sub-processors page, respectively.
            </li>
          </ul>
          <p>
            For the <strong>UK</strong>, the ICO&apos;s International Data Transfer Addendum applies
            to the SCCs. For <strong>Switzerland</strong>, references to the GDPR are read as
            references to the FADP and the Swiss Federal Data Protection and Information
            Commissioner is the competent authority.
          </p>
          <p>
            We rely on the SCCs as the backbone rather than on any single adequacy framework, so
            that our transfer basis does not evaporate if a framework is struck down.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.assistance}>8. Assisting you</AnchoredHeading>
          <p>
            <strong>Data-subject requests.</strong> The dashboard, API, CLI, and MCP server let you
            search, export, and delete the data you&apos;ve captured, which is normally enough to
            answer an access, rectification, erasure, restriction, or portability request yourself.
            If it isn&apos;t, we&apos;ll help you — at no charge for a reasonable volume of
            requests. If a data subject comes to <em>us</em> directly about data we hold as your
            processor, we won&apos;t answer them on the substance; we&apos;ll tell them to come to
            you, and tell you it happened.
          </p>
          <p>
            <strong>DPIAs and prior consultation.</strong> We&apos;ll give you the information you
            reasonably need for a data-protection impact assessment or a consultation with a
            supervisory authority, to the extent it concerns our processing and you can&apos;t get
            it elsewhere.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.dataBreaches}>9. Personal data breaches</AnchoredHeading>
          <p>
            If we become aware of a personal data breach affecting the data we process for you, we
            will notify you <strong>without undue delay, and in any event within 72 hours</strong>{" "}
            of becoming aware of it.
          </p>
          <p>
            The notice will describe what happened, the categories and approximate volume of data
            and data subjects affected so far as we know them, the likely consequences, and what we
            are doing about it. If we can&apos;t give you all of that at once, we&apos;ll send what
            we have and follow up — <strong>we won&apos;t sit on a partial picture</strong> to make
            the first message tidier.
          </p>
          <p>
            Notifying you is not an admission of fault. Reporting to a supervisory authority or to
            affected individuals is <strong>your</strong> call as controller, and we&apos;ll help
            you make it.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.returnAndDeletion}>
            10. Return and deletion
          </AnchoredHeading>
          <p>
            You can delete your data at any time from your account, and captured webhooks expire
            automatically at the end of your plan&apos;s retention window without you doing
            anything.
          </p>
          <p>
            <strong>When your account closes</strong>, we delete the personal data we process for
            you — including the stored payload bodies — <strong>within 30 days</strong>, unless EU
            or Member State law requires us to keep it. Export what you need before you close the
            account: after that window we can&apos;t get it back for you.
          </p>
          <p>
            Residual copies in encrypted backups are removed on the normal backup-rotation cycle,
            and remain subject to this DPA until they are.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.audits}>11. Audits (Article 28(3)(h))</AnchoredHeading>
          <p>
            On reasonable request, and no more than once a year unless a supervisory authority or a
            breach requires otherwise, we will give you the information you need to verify that
            we&apos;re meeting this DPA — normally by answering a security questionnaire and
            providing whatever documentation we have.
          </p>
          <p>
            <strong>Being straight with you:</strong> webhook.co is operated by one person and we
            hold no third-party audit report to hand you. We are not going to pretend an on-site
            audit of a serverless platform is a thing we can offer. If your compliance process
            strictly requires a SOC 2 report, we don&apos;t have one — and you should factor that in
            before you build on us.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.liability}>
            12. Liability, and how this fits the Terms
          </AnchoredHeading>
          <p>
            Each party&apos;s liability under this DPA is subject to the limitations and exclusions
            in the <a href="/terms">Terms of Service</a> — except where the GDPR or other applicable
            law does not permit that, in which case the law wins. Nothing here limits any right a
            data subject has directly against either of us.
          </p>
          <p>
            If anything in this DPA conflicts with the Terms, <strong>this DPA wins</strong> for the
            personal data we process on your behalf.
          </p>

          <AnchoredHeading id={DPA_ANCHORS.changes}>13. Changes</AnchoredHeading>
          <p>
            We may update this DPA — to reflect a change in the law, in our sub-processors, or in
            the Service. If a change materially reduces your protection we&apos;ll give you
            reasonable advance notice by email or in the dashboard. The date at the top always
            reflects the current version.
          </p>
          <p>
            Questions, or a countersignature request:{" "}
            <a href="mailto:legal@webhook.co">legal@webhook.co</a>.
          </p>
        </LegalDoc>
      </main>
      <Footer />
    </>
  );
}
