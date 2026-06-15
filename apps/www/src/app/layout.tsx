import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import "./globals.css";

const title = "webhook.co: the webhook platform built for the agent era";
const description =
  "Capture any webhook, inspect every request, and replay it to localhost in one command. " +
  "Then turn it into an event your agents can act on. MCP-native. Private by default.";

export const metadata: Metadata = {
  metadataBase: new URL("https://webhook.co"),
  title,
  description,
  openGraph: {
    title,
    description,
    url: "https://webhook.co",
    siteName: "webhook.co",
    type: "website",
  },
  twitter: { card: "summary_large_image", title, description },
};

// The marketing site is light-only by design (the design system reserves the dark toggle for
// the app), so there is no theme-init script and no `data-theme` — the tokens resolve to their
// light values. Geist faces are self-hosted via the `geist` package and wired into the type
// tokens in globals.css.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
