import { Mark, Wordmark } from "@webhook-co/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[var(--container-prose)] flex-col items-center justify-center gap-8 px-6 py-20 text-center">
      <div className="flex flex-col items-center gap-5">
        <Mark size={64} className="text-fg" />
        <Wordmark markSize={26} hideMark />
      </div>

      <div className="flex flex-col items-center gap-3">
        <p className="font-mono text-xs uppercase tracking-mono-label text-fg-muted">coming soon</p>
        <p className="max-w-[42ch] text-md leading-body text-fg-secondary text-balance">
          webhook.co is almost here. We&apos;d rather get it right than get it loud — check back
          shortly.
        </p>
      </div>
    </main>
  );
}
