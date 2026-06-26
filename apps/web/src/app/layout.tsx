import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { themeInitScript } from "@webhook-co/ui";

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
      <body>{children}</body>
    </html>
  );
}
