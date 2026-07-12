import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { PageShell } from "@/components/marketing/page-shell";
import { PlayTester } from "@/components/marketing/play/play-tester";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";

// /play is a NOINDEX sandbox: it's not in the sitemap (routes.ts sitemap:false) and it carries a
// robots noindex, because captured content is ephemeral/user-generated and must never be indexed
// under the brand. (The SEO gate only inspects sitemap pages, so a noindex here doesn't trip it.)
export const metadata = {
  ...pageMetadata({
    path: "/play",
    title: "Try it — the webhook sandbox",
    description:
      "A no-signup sandbox: generate a throwaway URL, send it a webhook, and watch the request land in your browser. Auto-deletes in 15 minutes.",
  }),
  robots: { index: false, follow: false },
};

export default function PlayPage() {
  return (
    <PageShell>
      <section className={container}>
        <div className="mx-auto max-w-[62ch] pt-[clamp(40px,6vw,72px)] pb-[clamp(24px,3vw,40px)] text-center">
          <SectionEyebrow rule={false} className="mb-4 justify-center">
            sandbox
          </SectionEyebrow>
          <h1 className="mb-5 text-[clamp(30px,4.6vw,46px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
            Send a webhook. Watch it land.
          </h1>
          <p className="mx-auto max-w-[52ch] text-lg text-pretty text-fg-secondary">
            No account, nothing saved. Generate a throwaway URL, point anything at it, and see the
            exact request — headers and body — appear here. The sandbox deletes itself in 15
            minutes.
          </p>
        </div>
      </section>

      <section className={cn(container, sectionPad, "pt-0")}>
        <PlayTester />
      </section>
    </PageShell>
  );
}
