import { Button, cn } from "@webhook-co/ui";

import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { container, focusRing, sectionPad } from "@/lib/styles";

// Rendered by Next for any unmatched route. Under `output: "export"` Next emits this to
// out/404.html, which the Worker serves — with a 404 status — for unknown paths via wrangler's
// `not_found_handling: "404-page"`. It's static chrome only (no per-request data), and the 404
// status itself is what keeps it out of search results, so no robots meta is needed here.
//
// Colours are picked by hand for AA: the real-browser a11y gate (a11y-e2e) only scans `/`, so it
// won't catch a contrast regression on this page. `text-fg-muted` is the site's vetted
// visible-secondary tone (used across the hero/footer); `text-fg-faint` is decorative-only and is
// deliberately avoided for real text.
export default function NotFound() {
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
        <Nav />
      </header>
      <main id="main" className={cn(container, sectionPad, "text-center")}>
        <p className="font-mono text-[11px] tracking-mono-label text-fg-muted uppercase">404</p>
        <h1 className="mx-auto mt-4 mb-5 max-w-[20ch] text-[clamp(30px,4.6vw,50px)] leading-[1.05] font-semibold tracking-display text-fg">
          That page didn&rsquo;t land.
        </h1>
        <p className="mx-auto mb-8 max-w-[52ch] text-lg text-pretty text-fg-secondary">
          The link is broken or the page moved. Nothing was captured here — head back and pick up
          where you left off.
        </p>
        <div className="flex justify-center">
          <Button asChild size="md">
            <a href="/">Back to home</a>
          </Button>
        </div>
      </main>
      <Footer />
    </>
  );
}
