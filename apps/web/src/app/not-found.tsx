import { Button } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";

// dal-gate-allow: a static 404 — renders no tenant data.

export const metadata: Metadata = {
  title: "Page not found · webhook.co",
};

/**
 * The dashboard's 404. A custom (server-rendered) not-found is what `notFound()` renders — replacing
 * Next's built-in default, whose client-component render path re-renders the root layout's inline theme
 * <script> on the client (React 19 warns it can't execute inline scripts there). It also keeps a missing
 * page on-brand instead of the framework's bare default.
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <p className="font-mono text-sm text-fg-muted">404</p>
        <h1 className="text-2xl font-semibold tracking-heading text-fg">
          This page doesn&apos;t exist
        </h1>
        <p className="leading-snug text-fg-secondary">
          The page you&apos;re looking for may have been moved or deleted, or the link was mistyped.
        </p>
        <Button asChild>
          <Link href="/endpoints">Back to endpoints</Link>
        </Button>
      </div>
    </main>
  );
}
