import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import "./globals.css";

export const metadata: Metadata = {
  title: "webhook.co — sign in",
  description: "Sign in to webhook.co.",
};

// Set the theme before paint to avoid a light-to-dark flash (in-app is light + dark via `data-theme`,
// stored under `wh-theme`). Inlined here for the scaffold; E1 promotes `themeInitScript` into
// `@webhook-co/ui` and both apps/web + apps/auth import the shared version.
const themeInitScript = `(function(){try{var t=localStorage.getItem("wh-theme");if(!t){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
