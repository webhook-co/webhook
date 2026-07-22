import { pageMetadata } from "@/app/metadata";
import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { AnchoredHeading } from "@/components/marketing/anchored-heading";
import { LegalDoc } from "@/components/marketing/legal-doc";
import { Nav } from "@/components/marketing/nav";
import { PRIVACY_ANCHORS } from "@/app/legal-anchors";
import { SkipLink } from "@/components/marketing/skip-link";

// pageMetadata sets this page's own canonical + og:url (root inherits canonical:"/" otherwise).
export const metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy Policy",
  description: "How the hosted webhook.co service handles your personal data.",
});

export default function PrivacyPage() {
  return (
    <>
      <SkipLink />
      <header>
        <AnnounceBar />
        <Nav />
      </header>
      <main id="main">
        <LegalDoc title="Privacy Policy" updated="13 July 2026">
          <blockquote>
            <strong>In short (this summary isn't the legal text, but it's honest):</strong> This
            policy covers the <strong>hosted</strong> webhook.co service. We play{" "}
            <strong>two roles</strong>: for your <em>account</em> details we're the data controller;
            for the <em>webhooks you send through us</em> — which may contain other people's data —
            we're a <em>processor</em> acting on your instructions.{" "}
            <strong>We don't sell your data</strong> and we don't use it for advertising. Your data
            is currently hosted mainly in the <strong>United States</strong>, and we protect
            transfers with <strong>Standard Contractual Clauses</strong>. Captured webhooks{" "}
            <strong>expire automatically</strong> once they pass your plan&apos;s retention window
            (7 days on the free plan), you can delete anything yourself at any time, and we&apos;ll{" "}
            <strong>honour erasure requests within 30 days</strong>. We&apos;re <strong>not</strong>{" "}
            SOC 2 / HIPAA certified, so please don&apos;t send data that needs those. Questions or
            requests: <a href="mailto:privacy@webhook.co">privacy@webhook.co</a>.
          </blockquote>

          <AnchoredHeading id={PRIVACY_ANCHORS.whoWeAre}>
            1. Who we are, and what this policy covers
          </AnchoredHeading>
          <p>
            The hosted webhook.co service (the "Service") is operated by{" "}
            <strong>Sourabh Choraria</strong>, a sole trader based in Porto, Portugal ("webhook.co",
            "we", "us"). For data-protection purposes, we are the controller of your account data.
            Contact: <a href="mailto:privacy@webhook.co">privacy@webhook.co</a>.
          </p>
          <p>
            This policy explains what personal data we handle through the hosted Service and why. It
            applies to the webhook.co websites, dashboard, API, CLI, and MCP server that we operate.
          </p>
          <p>
            <strong>Scope — hosted Service only.</strong> This policy covers the Service we operate
            at the webhook.co domains. webhook.co's open-source software (licensed under the Apache
            License 2.0, at <a href="https://github.com/webhook-co">github.com/webhook-co</a>) can
            be run by others; if you <strong>self-host</strong> it, we don't operate it and don't
            process the data in your deployment — you do, and you're responsible for your own
            privacy compliance.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.controllerAndProcessor}>
            2. Our two roles: controller and processor
          </AnchoredHeading>
          <ul>
            <li>
              <strong>Account data — we're the controller.</strong> Information about you and your
              organisation (sign-up details, billing, usage, support). This policy governs how we
              handle it.
            </li>
            <li>
              <strong>Webhook data you send through us — we're a processor.</strong> The webhooks,
              payloads, and headers you capture may contain personal data belonging to <em>your</em>{" "}
              users or third parties. For that data, <strong>you</strong> are the controller and{" "}
              <strong>we</strong> process it only to run the Service for you, on your instructions.
              Business customers can put this on a formal footing with our{" "}
              <a href="/dpa">
                <strong>Data Processing Agreement</strong>
              </a>
              . This policy's controller-focused sections (legal bases, your individual rights) are
              about <em>account</em> data; for the data you capture, your own privacy notice and our
              DPA govern.
            </li>
          </ul>

          <AnchoredHeading id={PRIVACY_ANCHORS.whatWeCollect}>3. What we collect</AnchoredHeading>
          <p>
            <strong>Account &amp; identity data (you give us):</strong> your name, email address,
            and — if you sign in with Google or GitHub — the basic profile information and avatar
            those providers share. We support Google, GitHub, and email "magic-link" sign-in;{" "}
            <strong>we don't store passwords</strong>. We keep the tokens needed to maintain your
            linked sign-in.
          </p>
          <p>
            <strong>Organisation data:</strong> your organisation's name, members, and roles.
          </p>
          <p>
            <strong>Authentication &amp; session data:</strong> when you're signed in, we store a
            session record that includes your <strong>IP address and browser user-agent</strong> (to
            keep the session secure). API keys are stored only as a <strong>one-way hash</strong> —
            we can't see the original.
          </p>
          <p>
            <strong>The webhooks you capture (processor data):</strong> the full request bodies and
            headers of the webhooks you send through the Service, plus verification and delivery
            metadata. We store these so you can inspect, search, verify, replay, and deliver them —
            that's the core feature.{" "}
            <strong>We store headers and bodies as received (unredacted)</strong>, because redacting
            them would defeat the inspection purpose. These may contain personal data of your
            end-users; we process it as your processor.
          </p>
          <p>
            <strong>Usage data:</strong> counts of the events you process, used for metering,
            billing, and keeping the Service reliable.
          </p>
          <p>
            <strong>Billing data:</strong> if you buy a paid plan, our payment processor{" "}
            <strong>Stripe</strong> handles your card details —{" "}
            <strong>we don't store full card numbers</strong>; we keep records of your plan,
            invoices, and payment status.
          </p>
          <p>
            <strong>CLI telemetry (optional, opt-out):</strong> our open-source <code>wbhk</code>{" "}
            command-line tool sends anonymous usage pings by default — the CLI version, your
            OS/architecture, which command ran, and whether it succeeded. It <strong>never</strong>{" "}
            includes your data, arguments, tokens, URLs, IDs, or any persistent identifier, and it's
            collected via Cloudflare Analytics Engine. You can turn it off any time (
            <code>wbhk telemetry off</code>, <code>WBHK_TELEMETRY=0</code>, or{" "}
            <code>DO_NOT_TRACK=1</code>), and it's automatically off in CI. This applies to anyone
            using the CLI, whether or not they're a paying customer.
          </p>
          <p>
            <strong>Website analytics (aggregate, cookieless):</strong> to see which pages people
            find useful, this marketing site records a single anonymous measurement per page view —
            the page path, the referring site's domain, a country-level location, and any campaign
            (UTM) tags in the link you followed. It's measured on our servers via Cloudflare
            Analytics Engine and <strong>sets no cookie</strong>. We <strong>don't</strong> store
            your IP address, and there's no identifier that could link one page view to another or
            follow you across sites — so it can't be tied back to you.
          </p>
          <p>
            <strong>Page performance (in your browser, cookieless):</strong> we also load{" "}
            <strong>Cloudflare Web Analytics</strong>, a small script that measures how fast the
            page actually loaded for you — timings such as how long it took to render, plus the page
            path, referring domain, and general device and browser type. It{" "}
            <strong>sets no cookie</strong>, writes nothing to your browser's storage, and builds no
            profile or cross-site identifier, which is why it runs without a consent prompt. We use
            it to find slow pages. You can block it with any content blocker without affecting the
            site.
          </p>
          <p>
            <strong>Acquisition source (attribution):</strong> separately, if you arrive from a
            marketing link <em>and</em> accept our cookie banner, we set one first-party cookie
            recording <em>only</em> that link's campaign (UTM) tags — never personal data — so we
            can see, in aggregate, which channels bring developers to webhook.co. If you decline, we
            don't set it. See <a href="#cookies">Cookies</a> below.
          </p>
          <p>
            <strong>Support communications:</strong> if you email us, we keep the correspondence to
            help you.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.legalBasis}>
            4. Why we use it, and our legal basis (GDPR)
          </AnchoredHeading>
          <ul>
            <li>
              <strong>To provide the Service</strong> (create your account, run endpoints,
              store/inspect/deliver your webhooks, metering) —{" "}
              <em>performance of our contract with you</em> (Art 6(1)(b)).
            </li>
            <li>
              <strong>To take payment</strong> — <em>contract</em>, and <em>legal obligation</em>{" "}
              for tax/accounting records (Art 6(1)(c)).
            </li>
            <li>
              <strong>To keep the Service secure and prevent abuse</strong> (session security,
              rate-limiting, CAPTCHA, investigating misuse) — <em>our legitimate interests</em> in a
              safe, reliable service (Art 6(1)(f)).
            </li>
            <li>
              <strong>To understand and improve the Service</strong> (anonymous CLI telemetry,
              aggregate cookieless website analytics) — <em>legitimate interests</em>; you can opt
              out of CLI telemetry.
            </li>
            <li>
              <strong>To see which channels bring developers to us</strong> (the first-party
              attribution cookie, <code>wh_first_touch</code>) — <em>your consent</em> (Art
              6(1)(a)), which you give or decline through the cookie banner and can withdraw at any
              time.
            </li>
            <li>
              <strong>To respond to support requests</strong> — <em>legitimate interests</em> /{" "}
              <em>contract</em>.
            </li>
            <li>
              <strong>The webhook data you capture</strong> — processed on your behalf under our
              contract and your instructions (you determine the legal basis as its controller).
            </li>
          </ul>
          <p>
            We don't send marketing emails except transactional/service messages, unless you opt in.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.subProcessors}>
            5. Who we share it with (sub-processors)
          </AnchoredHeading>
          <p>
            We don't sell your data or share it for advertising. To run the Service we rely on a
            small set of trusted infrastructure providers (sub-processors) — including{" "}
            <strong>Cloudflare</strong>, <strong>Neon</strong>, <strong>Amazon Web Services</strong>
            , <strong>Stripe</strong>, <strong>Resend</strong>, <strong>Google</strong> and{" "}
            <strong>GitHub</strong> (only if you sign in with them), and <strong>Mintlify</strong>{" "}
            (our documentation site). Our <a href="/sub-processors">Sub-processors page</a> lists
            each one, what it does, the data it may process, and where it's located, and we update
            it whenever the list changes.
          </p>
          <p>
            We may also disclose data if required by law, to protect our rights or users' safety, or
            as part of a business transfer — in which case we'll tell you.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.internationalTransfers}>
            6. Where your data is, and international transfers
          </AnchoredHeading>
          <p>
            Your data is currently hosted <strong>primarily in the United States</strong> (our
            database and object storage default to US regions). We do <strong>not</strong> currently
            offer EU data residency. Because we're based in the EU and use US-based providers,
            moving data to them is an international transfer; we rely on{" "}
            <strong>Standard Contractual Clauses (SCCs)</strong> incorporated into our agreements
            with those providers, together with technical safeguards (encryption in transit and at
            rest), and UK/Swiss addenda where relevant. We rely on SCCs as our primary safeguard
            rather than depending on the EU–US Data Privacy Framework alone.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.retention}>7. How long we keep it</AnchoredHeading>
          <ul>
            <li>
              <strong>Account data:</strong> for as long as your account is open, and a reasonable
              period afterwards for legal, tax, and security purposes.
            </li>
            <li>
              <strong>The webhooks you capture:</strong> these <strong>expire automatically</strong>
              . Captured events and their stored payload bodies are deleted once they pass your
              plan&apos;s retention window — on the free plan, <strong>7 days</strong>. The window
              for each paid plan is listed at <a href="/pricing">webhook.co/pricing</a>. Expiry runs
              on a schedule; deletion happens shortly after an event passes the window rather than
              at the exact second it does. You can also delete an individual event yourself at any
              time: its content becomes <strong>immediately inaccessible</strong> (headers and
              identifiers are redacted the moment you delete it) and its stored payload body is{" "}
              <strong>purged shortly after</strong>. We keep a minimal record that the event was
              received — with no personal data — so your usage count can&apos;t be rewritten by
              deleting events (deleting does not reduce what you were billed).
            </li>
            <li>
              <strong>If your window gets shorter:</strong> if you move to a plan with a shorter
              retention window — by downgrading, or by cancelling and returning to the free tier —
              the shorter window applies from then on, and captured data already older than it
              becomes eligible for deletion. Export anything you want to keep <em>before</em> you
              downgrade or cancel.
            </li>
            <li>
              <strong>Deletion &amp; erasure:</strong> you can delete endpoints, events, and your
              whole organisation from your account — this redacts the personal data and purges the
              stored payload bodies, not just a listing (for a deleted event we keep only a
              personal-data-free record that it was received, so your billed usage stays honest).
              You can also ask us to erase your personal data (see §8); we complete verified erasure
              requests <strong>within 30 days</strong>. Residual copies in encrypted backups are
              removed on our normal backup-rotation cycle.
            </li>
          </ul>

          <AnchoredHeading id={PRIVACY_ANCHORS.yourRights}>8. Your rights</AnchoredHeading>
          <p>
            Subject to applicable law, you can ask to <strong>access</strong> your personal data,{" "}
            <strong>correct</strong> it, <strong>delete/erase</strong> it, <strong>restrict</strong>{" "}
            or <strong>object</strong> to certain processing, receive a <strong>portable</strong>{" "}
            copy, and <strong>withdraw consent</strong> where we rely on it. To exercise any of
            these, email <a href="mailto:privacy@webhook.co">privacy@webhook.co</a>; we'll respond
            within the time the law requires (generally one month). You also have the right to
            complain to a supervisory authority — in Portugal, the{" "}
            <strong>Comissão Nacional de Proteção de Dados (CNPD)</strong> — or your local EU/EEA
            authority.
          </p>
          <p>
            If your request concerns the webhook data you captured (where you're the controller and
            we're the processor), we'll help you fulfil it, but you may need to direct the
            underlying request through the customer whose account holds the data.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.security}>
            9. How we protect your data
          </AnchoredHeading>
          <ul>
            <li>
              <strong>In transit:</strong> all connections use TLS.
            </li>
            <li>
              <strong>Secrets:</strong> the signing secrets, provider secrets, and ingest tokens you
              entrust to us are encrypted at rest using AES-256-GCM envelope encryption, with the
              master keys held in <strong>AWS KMS</strong> (we never hold them in plaintext).
            </li>
            <li>
              <strong>At rest:</strong> data stored in our database and object storage benefits from
              those providers' at-rest encryption.
            </li>
            <li>
              <strong>Isolation:</strong> tenant data is separated using database row-level security
              so one organisation can't read another's data.
            </li>
            <li>
              <strong>Authentication:</strong> OAuth and magic-link sign-in, hashed API keys, and
              audience-bound tokens.
            </li>
          </ul>
          <p>
            Being honest about limits: the Service is <strong>not</strong> end-to-end-encrypted or
            "zero-knowledge" — we necessarily process your webhook contents to inspect, verify,
            replay, and deliver them. And we do <strong>not</strong> currently hold SOC 2, ISO
            27001, HIPAA, or PCI certifications; please don't use the Service for data that legally
            requires them (see the <a href="/terms">Terms</a>).
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.cookies}>10. Cookies</AnchoredHeading>
          <p>
            We keep cookies to a minimum. The <strong>strictly-necessary</strong> ones are:
          </p>
          <ul>
            <li>
              a <strong>session cookie</strong> that keeps you signed in,
            </li>
            <li>
              short-lived <strong>security cookies</strong> used during Google/GitHub sign-in (to
              prevent cross-site request forgery), and
            </li>
            <li>
              a small cookie that remembers your <strong>cookie choice</strong>, so we don't ask
              again.
            </li>
          </ul>
          <p>
            Separately, when you arrive from a marketing link we ask — through a{" "}
            <strong>cookie banner</strong> — whether we may set one{" "}
            <strong>first-party attribution cookie</strong> (<code>wh_first_touch</code>). It
            records <em>only</em> that link's marketing source — its UTM campaign tags, never
            personal data — so we can understand, in aggregate, which channels bring developers to
            webhook.co. We set it <strong>only if you accept</strong>; if you decline, we don't set
            it — and either way we remember your choice so we don't ask again. When set, it's tied
            to your organisation at signup (not to a browsing profile), expires after 90 days, and
            is written once — a later visit never overwrites it. To withdraw consent, clear the
            cookie in your browser.
          </p>
          <p>
            The strictly-necessary cookies aren't used for tracking or advertising. Our login page
            also loads <strong>Cloudflare Turnstile</strong> (bot protection), which may set its own
            security cookies as a third-party service. Your dark-mode preference is stored in your
            browser's local storage, not a cookie. We <strong>don't</strong> use advertising
            cookies.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.children}>11. Children</AnchoredHeading>
          <p>
            The Service isn't directed to children, and we don't knowingly collect data from anyone
            under 16 (or the age of digital consent where you live). If you believe a child has
            given us data, contact us and we'll remove it.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.dataBreaches}>12. Data breaches</AnchoredHeading>
          <p>
            If a breach affects your personal data, we'll act without undue delay and, where the law
            requires, notify the relevant supervisory authority within <strong>72 hours</strong>,
            and notify you where there's a high risk to you.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.californiaResidents}>
            13. California residents (CCPA/CPRA)
          </AnchoredHeading>
          <p>
            If you're a California resident:{" "}
            <strong>we do not sell or share your personal information</strong>, and we don't use it
            for cross-context behavioural advertising. When we handle the data you capture, we act
            as your <strong>service provider</strong> and use it only to provide the Service. You
            have rights to know, delete, and correct your personal information; email{" "}
            <a href="mailto:privacy@webhook.co">privacy@webhook.co</a> to exercise them, and we
            won't discriminate against you for doing so.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.changes}>14. Changes to this policy</AnchoredHeading>
          <p>
            We may update this policy. For material changes we'll post them here with reasonable
            notice before they take effect and update the "Last updated" date above — so check back
            periodically.
          </p>

          <AnchoredHeading id={PRIVACY_ANCHORS.contact}>15. Contact</AnchoredHeading>
          <p>
            <strong>Sourabh Choraria</strong> (webhook.co), Porto, Portugal —{" "}
            <a href="mailto:privacy@webhook.co">privacy@webhook.co</a>. For EU/EEA privacy
            complaints you may also contact the <strong>CNPD</strong> (the Portuguese
            data-protection authority) or your local supervisory authority.
          </p>
        </LegalDoc>
      </main>
      <Footer />
    </>
  );
}
