import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { themeInitScript } from "@/components/theme-toggle";

import "./globals.css";

export const metadata: Metadata = {
  title: "webhook.co — design system",
  description:
    "The webhook.co design system: tokens, theming, and primitives for a monochrome, machined, and quiet product surface.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Set the theme before paint to avoid a light-to-dark flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
