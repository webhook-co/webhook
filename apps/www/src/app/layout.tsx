import type { ReactNode } from "react";
import { themeInitScript } from "@webhook-co/ui";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { StructuredData } from "@/components/marketing/structured-data";
import { siteMetadata, siteViewport } from "./metadata";
import "./globals.css";

// Metadata + viewport live in ./metadata (a font/CSS-free module) so they can be unit-tested
// without dragging next/font into the test runner. Re-exported here for Next to pick them up.
export const metadata = siteMetadata;
export const viewport = siteViewport;

// The marketing site ships light AND dark and defaults to DARK (a stored `wh-theme` choice from the
// nav toggle always wins). `themeInitScript` runs BEFORE first paint and stamps `data-theme` on
// <html> from localStorage, defaulting to dark when nothing is stored — a static export has no
// server to read a cookie, so without a pre-paint inline script a first-time (dark) visitor gets a
// light flash on every navigation. `suppressHydrationWarning` on <html> because that attribute is
// written by the script and therefore differs from the server-rendered markup by design.
// Geist faces are self-hosted via the `geist` package and wired into the type tokens in globals.css.

/**
 * Turns smooth scrolling on at the first user interaction — and not one moment sooner.
 *
 * `scroll-behavior: smooth` cannot simply be declared on the root: Chrome then drops the *load-time*
 * fragment scroll. Measured on `/terms#limitation-of-liability` — with `auto` the page lands on the
 * heading (scrollY 5546); with `smooth` it never scrolls at all (scrollY 0). Since a pasted
 * `/dpa#sub-processors` link is exactly what the legal anchors exist for, breaking that to gain an
 * animation would be a bad trade.
 *
 * Gating on the first click/keypress makes the ordering *structural* rather than lucky: at load time
 * no interaction has happened, so the class cannot be present, so the cold-load jump is always
 * native, instant and precise. The listener runs in the capture phase, so the very click that enables
 * smooth is itself smooth. Reduced-motion is handled in CSS, so this stays a class toggle either way.
 */
const ENABLE_SMOOTH_SCROLL_ON_INTERACTION = `
addEventListener('click',function(){document.documentElement.classList.add('smooth-scroll')},{once:true,capture:true});
addEventListener('keydown',function(){document.documentElement.classList.add('smooth-scroll')},{once:true,capture:true});
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <head>
        {/* Render-blocking ON PURPOSE: it must win the race against the first paint, or dark-mode
            readers see a white flash. It is tiny, and the CSP already allows 'unsafe-inline' for
            Next's own hydration scripts. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <script
          // A static, compile-time constant — no interpolation, no user input.
          dangerouslySetInnerHTML={{ __html: ENABLE_SMOOTH_SCROLL_ON_INTERACTION }}
        />
        <StructuredData />
        {children}
      </body>
    </html>
  );
}
