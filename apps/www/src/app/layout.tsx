import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { StructuredData } from "@/components/marketing/structured-data";
import { siteMetadata, siteViewport } from "./metadata";
import "./globals.css";

// Metadata + viewport live in ./metadata (a font/CSS-free module) so they can be unit-tested
// without dragging next/font into the test runner. Re-exported here for Next to pick them up.
export const metadata = siteMetadata;
export const viewport = siteViewport;

// The marketing site is light-only by design (the design system reserves the dark toggle for
// the app), so there is no theme-init script and no `data-theme` — the tokens resolve to their
// light values. Geist faces are self-hosted via the `geist` package and wired into the type
// tokens in globals.css.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <StructuredData />
        {children}
      </body>
    </html>
  );
}
