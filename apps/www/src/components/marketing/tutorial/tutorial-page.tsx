import { cn } from "@webhook-co/ui";

import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { PageShell } from "@/components/marketing/page-shell";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { Terminal, TerminalLine, Tok } from "@/components/ui/terminal";
import { LINKS } from "@/lib/links";
import { container, proseLink, sectionPad } from "@/lib/styles";
import { type Tutorial, tutorialPath } from "@/lib/tutorials";

// The shell every /test/<slug> page shares. It deliberately owns ONLY the parts that are identical
// everywhere — the capture → listen → replay loop, which is a property of webhook.co rather than of the
// provider — and renders the authored, per-provider prose around it. Keeping shared sentences to this
// minimum is what lets sixteen sibling pages clear the near-duplicate guard; see `lib/tutorials.ts`.

const h2 = "text-2xl font-semibold tracking-heading text-fg sm:text-[1.75rem]";
const body = "text-md text-pretty text-fg-secondary";

export function TutorialPage({ tutorial: t }: { tutorial: Tutorial }) {
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: t.name, path: tutorialPath(t.slug) },
          ]}
        />
      }
    >
      <section className={container}>
        <div className="mx-auto max-w-[62ch] pt-[clamp(40px,6vw,72px)] pb-[clamp(20px,3vw,32px)] text-center">
          <SectionEyebrow rule={false} className="mb-4 justify-center">
            test locally
          </SectionEyebrow>
          <h1 className="mb-5 text-[clamp(30px,4.6vw,46px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
            {t.h1}
          </h1>
          <p className="mx-auto max-w-[54ch] text-lg text-pretty text-fg-secondary">{t.lede}</p>
        </div>
      </section>

      <article className={cn(container, sectionPad, "pt-0")}>
        {/* `grid-cols-1` and `min-w-0` are load-bearing, not decoration: an implicit grid track sizes to
            max-content, so the terminal's long `wbhk listen …` line would widen the whole page and trip
            the no-horizontal-overflow check on a phone. Pinning one minmax(0,1fr) column makes the
            terminal scroll inside its own box instead. */}
        <div className="mx-auto grid max-w-[68ch] grid-cols-1 gap-[clamp(32px,4vw,48px)] [&>*]:min-w-0">
          {/* The one genuinely shared section: the loop is ours, not the provider's. */}
          <section aria-labelledby="loop">
            <h2 id="loop" className={cn(h2, "mb-4")}>
              The loop
            </h2>
            <p className={cn(body, "mb-5")}>
              Create an endpoint and it prints a permanent ingest URL. Everything sent there is
              captured whole — headers, body, the exact bytes — before anything else happens. Stream
              those events to a port on your machine, and replay any one of them as often as you
              like while you fix the handler. Forwarding runs from your own machine, so it
              isn&apos;t a billable delivery.
            </p>
            {/* Command text lives in string expressions, never as bare JSX children. JSX collapses the
                whitespace around a child that wraps onto a second source line, and prettier decides
                where that wrap goes — which is how this rendered as "$wbhk listen" the first time. A
                string literal is immune to reflow, and `tutorial-page.test.tsx` pins the spacing. */}
            <Terminal title="wbhk" meta={t.slug}>
              <TerminalLine>
                <Tok.Dim>$</Tok.Dim>
                {` wbhk endpoints create ${t.slug}-dev`}
              </TerminalLine>
              <TerminalLine>
                <Tok.Ok>https://wbhk.my/whep_…</Tok.Ok>
              </TerminalLine>
              <TerminalLine aria-hidden="true"> </TerminalLine>
              <TerminalLine>
                <Tok.Dim>$</Tok.Dim>
                {" wbhk listen <endpoint-id> --forward http://localhost:3000/webhooks"}
              </TerminalLine>
              <TerminalLine>
                <Tok.Dim>$</Tok.Dim>
                {" wbhk replay <event-id> --forward http://localhost:3000/webhooks"}
              </TerminalLine>
            </Terminal>
          </section>

          <section aria-labelledby="distinctive">
            <h2 id="distinctive" className={cn(h2, "mb-4")}>
              What&apos;s different about {t.name}
            </h2>
            <p className={body}>{t.distinctive}</p>
          </section>

          <section aria-labelledby="configure">
            <h2 id="configure" className={cn(h2, "mb-4")}>
              Where the URL goes
            </h2>
            <p className={cn(body, "mb-4")}>{t.configure}</p>
            <p className={body}>{t.fireTest}</p>
          </section>

          <section aria-labelledby="events">
            <h2 id="events" className={cn(h2, "mb-4")}>
              What {t.name} sends
            </h2>
            <p className={cn(body, "mb-4")}>{t.eventsIntro}</p>
            {/* Long identifiers WRAP rather than scroll. Making each chip an overflow-x box turned it
                into a scrollable region, which axe requires to be keyboard-focusable — and satisfying
                that would have meant a tab stop per chip, so sixteen of them on the way to the next
                real control. Wrapping removes the scroll container instead of accommodating it, and
                still keeps the page itself from widening on a phone. */}
            <ul className="flex flex-wrap gap-2">
              {t.eventExamples.map((ev) => (
                <li
                  key={ev}
                  className="max-w-full rounded-control border border-hairline bg-surface-sunken px-2.5 py-1 font-mono text-sm break-words text-fg"
                >
                  {ev}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="gotchas">
            <h2 id="gotchas" className={cn(h2, "mb-4")}>
              Worth knowing first
            </h2>
            <div className="grid gap-5">
              {t.gotchas.map((g) => (
                <div key={g.heading} className="rounded-card border border-hairline bg-surface p-5">
                  <h3 className="mb-2 font-semibold text-fg">{g.heading}</h3>
                  <p className="text-md text-pretty text-fg-secondary">{g.body}</p>
                </div>
              ))}
            </div>
          </section>

          <p className="text-md text-pretty text-fg-muted">
            Signature checking is handled for you once the secret is registered — you can also check
            a captured signature by hand in the{" "}
            <a href={LINKS.verify} className={proseLink}>
              signature verifier
            </a>
            .
          </p>
        </div>
      </article>

      <Faq items={t.faq} heading={`${t.name} webhooks: common questions`} />
      <FinalCta />
    </PageShell>
  );
}
