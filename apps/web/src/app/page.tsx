import { Button, StatusPill, Wordmark } from "@webhook-co/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[var(--container-prose)] flex-col justify-center gap-8 px-6 py-20">
      <Wordmark markSize={28} />

      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs uppercase tracking-mono-label text-fg-muted">
          design system
        </p>
        <h1 className="text-4xl font-semibold leading-tight tracking-display text-fg text-balance">
          Monochrome, machined, and quiet.
        </h1>
        <p className="max-w-[60ch] text-md leading-body text-fg-secondary">
          The shared visual language for webhook.co — a single cool-slate ink scale, light and dark,
          with color reserved for the things that carry meaning. This is the home of the tokens,
          theming, and primitives every surface is built from.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <a href="https://github.com" rel="noreferrer">
            Read the source
          </a>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <StatusPill status="delivered" />
        <StatusPill status="retrying" />
        <StatusPill status="failed" />
        <StatusPill status="replayed" />
      </div>
    </main>
  );
}
