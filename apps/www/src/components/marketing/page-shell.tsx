import type { ReactNode } from "react";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { SkipLink } from "@/components/marketing/skip-link";

/**
 * The one page chrome for the whole marketing site: skip link → header (announce bar + nav) →
 * `<main id="main">` (the skip-link target) → footer. Every page wraps its content in this so the
 * landmark structure and skip-link wiring can't drift between pages — an accessibility regression a
 * class-presence test wouldn't catch. `after` renders after the footer, for page-level JSON-LD
 * (breadcrumbs) that belongs at the end of the document, outside <main>.
 */
export function PageShell({ children, after }: { children: ReactNode; after?: ReactNode }) {
  return (
    <>
      <SkipLink />
      <header>
        <AnnounceBar />
        <Nav />
      </header>
      <main id="main">{children}</main>
      <Footer />
      {after}
    </>
  );
}
