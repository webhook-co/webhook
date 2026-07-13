import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { themeInitScript } from "@webhook-co/ui";

import { BfcacheGuard } from "@/components/bfcache-guard";

import "./globals.css";

// dal-gate-allow: the html-shell root layout — renders no tenant data; the (app) layout gates.

export const metadata: Metadata = {
  title: "webhook.co",
  description: "The webhook.co dashboard.",
  // Private-by-default surface — never indexed (paired with the disallow-all robots.txt).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Set the theme before paint to avoid a light-to-dark flash. This inline <script> is harmless in
            production (it runs once on parse). In `next dev` ONLY, React 19 logs a "scripts inside React
            components" warning when the not-found render path client-renders the layout — a dev-overlay
            cosmetic that does not affect the deployed app. See docs/adr/0077. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        {/* Mounted at the ROOT, not in the org shell, and that placement is the point.
            A bfcache restore repaints a page from memory with NO request, NO server render and therefore NO
            session check — so the DAL gate, which is the only thing standing between a signed-out browser and
            a signed-in page, simply does not run. `Cache-Control: no-store` does not prevent this (it governs
            the HTTP cache, a different cache); `Clear-Site-Data: "cache"` used to, and was removed for costing
            ~25s of every logout.
            EVERY page in this app is authenticated — there are no public routes — so the guard belongs on the
            surface they all share. Under `org/[slug]` it would have missed `/`, `/org/new` and `/invite/*`,
            and the next route added would have had to remember to opt in. Here, none of that is possible. */}
        <BfcacheGuard />
        {children}
      </body>
    </html>
  );
}
