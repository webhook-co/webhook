import { themeInitScript } from "@webhook-co/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import "./globals.css";

export const metadata: Metadata = {
  title: "webhook.co — sign in",
  description: "Sign in to webhook.co.",
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
        {/* FIRST child of <body>, not inside <head>. React 19 HOISTS a <script> rendered into the
            tree, so a raw inline <script> in <head> is relocated between the server HTML and the
            hydrated DOM — a STRUCTURAL mismatch, which `suppressHydrationWarning` cannot cover
            (it only forgives an element's own attributes and text). That threw a recoverable
            React #418 on EVERY page of this app. Here the script still runs before any visible
            content is parsed, so the pre-paint stamp is unchanged and there is still no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {children}
      </body>
    </html>
  );
}
