import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { PageShell } from "@/components/marketing/page-shell";
import { PROVIDER_ENTRIES } from "@/components/marketing/provider-entries";
import { ProviderMark } from "@/components/marketing/provider-mark";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { LINKS } from "@/lib/links";
import { container, focusRing, proseLink, sectionPad } from "@/lib/styles";
import { TUTORIALS, tutorialPath } from "@/lib/tutorials";

// The parent every /test/<slug> page already claimed to have. Until this shipped, `/test` was a 404
// while sixteen children sat in the sitemap with ZERO inbound internal links from anywhere on the
// site — findable only by search or by typing the URL. This page is the fix, and `page.test.tsx`
// derives its completeness check from TUTORIALS so a new tutorial cannot go un-linked.
//
// It also targets the head term the sizing work identified as the real demand ("test webhooks
// locally"), which the per-provider long-tail was too thin to carry on its own.

export const metadata = pageMetadata({
  path: "/test",
  title: "Test webhooks locally",
  description:
    "Point a provider's webhooks at a permanent URL, stream them to localhost, and replay them while you fix the handler. Step-by-step guides for 16 providers.",
});

const bySlug = new Map(PROVIDER_ENTRIES.map((e) => [e.slug, e]));

export default function TestHubPage() {
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: "Test webhooks locally", path: "/test" },
          ]}
        />
      }
    >
      <section className={container}>
        <div className="mx-auto max-w-[62ch] pt-[clamp(40px,6vw,72px)] pb-[clamp(24px,3vw,40px)] text-center">
          <SectionEyebrow rule={false} className="mb-4 justify-center">
            test locally
          </SectionEyebrow>
          <h1 className="mb-5 text-[clamp(30px,4.6vw,46px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
            Test webhooks locally
          </h1>
          <p className="mx-auto max-w-[54ch] text-lg text-pretty text-fg-secondary">
            A webhook you can&apos;t see is a webhook you can&apos;t debug. Capture the real
            request, stream it to a port on your machine, and replay it as often as you need — no
            tunnel to babysit, no redeploy between attempts.
          </p>
        </div>
      </section>

      <section className={cn(container, sectionPad, "pt-0")}>
        <nav aria-label="All providers" className="mx-auto max-w-[68ch]">
          {/* One minmax(0,1fr) column per track: an implicit grid track sizes to max-content, which is
              how a long provider name would widen the whole page on a phone. */}
          <ul className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1 sm:grid-cols-3 [&>*]:min-w-0">
            {TUTORIALS.map((t) => {
              const entry = bySlug.get(t.slug);
              return (
                <li key={t.slug}>
                  <a
                    href={tutorialPath(t.slug)}
                    className={cn(
                      focusRing,
                      "flex items-center gap-2.5 rounded-card border border-hairline bg-surface px-3.5 py-3 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
                    )}
                  >
                    {entry ? <ProviderMark entry={entry} size={16} /> : null}
                    <span className="min-w-0 break-words">{t.name}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <p className="mx-auto mt-8 max-w-[62ch] text-md text-pretty text-fg-muted">
          Not listed? The loop is the same for every provider — point it at your ingest URL and the
          request is captured whole. You can also{" "}
          <a href={LINKS.play} className={proseLink}>
            send one to a throwaway URL
          </a>{" "}
          without an account, or check a captured signature by hand in the{" "}
          <a href={LINKS.verify} className={proseLink}>
            signature verifier
          </a>
          .
        </p>
      </section>
    </PageShell>
  );
}
