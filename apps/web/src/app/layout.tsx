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
      <body>
        {/* Sets the theme before paint, to avoid a light-to-dark flash.
            FIRST CHILD OF <body>, never inside <head>. React 19 HOISTS a <script> rendered into the
            tree, so an inline <script> in <head> is relocated between the server HTML and the hydrated
            DOM — a STRUCTURAL mismatch that `suppressHydrationWarning` cannot cover, since it only
            forgives an element's own attributes and text. On apps/auth, which had the identical shape,
            that threw a recoverable React #418 on EVERY page load in production. The previous comment
            here called the related React 19 warning "a dev-overlay cosmetic that does not affect the
            deployed app"; that was measured on apps/auth and found to be false, so this moved too.
            Running here still beats first paint of any visible content, so there is still no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
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
