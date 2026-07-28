import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { Faq } from "@/components/marketing/faq";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { PageShell } from "@/components/marketing/page-shell";
import { VerifyTool } from "@/components/marketing/verify/verify-tool";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";

import { VERIFY_FAQ } from "./verify-faq";

export const metadata = pageMetadata({
  path: "/verify",
  title: "Verify a webhook signature",
  description:
    "Check a webhook signature against its payload and secret, for 120+ providers, right in your browser. Nothing you paste ever leaves the page.",
});

export default function VerifyPage() {
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: "Verify a signature", path: "/verify" },
          ]}
        />
      }
    >
      <section className={container}>
        <div className="mx-auto max-w-[62ch] pt-[clamp(40px,6vw,72px)] pb-[clamp(24px,3vw,40px)] text-center">
          <SectionEyebrow rule={false} className="mb-4 justify-center">
            verify
          </SectionEyebrow>
          <h1 className="mb-5 text-[clamp(30px,4.6vw,46px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
            Verify a webhook signature
          </h1>
          <p className="mx-auto max-w-[54ch] text-lg text-pretty text-fg-secondary">
            Pick a provider, paste the payload, the signature header, and your signing secret — this
            checks it against the real verification code webhook.co runs for 120+ providers. Every
            byte stays in your browser: nothing you paste is sent anywhere or saved.
          </p>
        </div>
      </section>

      <section className={cn(container, sectionPad, "pt-0")}>
        <div className="mx-auto max-w-[62ch] rounded-panel border border-hairline bg-surface p-[clamp(20px,3vw,32px)]">
          <VerifyTool />
        </div>
        <p className="mx-auto mt-6 max-w-[62ch] text-sm text-fg-muted">
          How it works: your inputs are assembled into the exact bytes the provider signs, and the
          signature is recomputed with Web Crypto and compared in constant time — the same audited
          engine that verifies every event on webhook.co. Providers whose key is fetched from their
          own servers can&apos;t be checked in a browser and are left out.
        </p>
      </section>

      <Faq items={VERIFY_FAQ} heading="Webhook signature verification: common questions" />
    </PageShell>
  );
}
