import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusPill,
  Wordmark,
  ink,
} from "@webhook-co/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

import { MotionDemo } from "@/components/motion-demo";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = {
  title: "webhook.co — design system showcase",
  description: "A living showcase of the webhook.co design tokens and UI primitives.",
};

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5 border-t border-hairline pt-12">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-mono-label text-fg-muted">{eyebrow}</p>
        <h2 className="text-2xl font-semibold tracking-heading text-fg">{title}</h2>
      </div>
      {children}
    </section>
  );
}

const STATES = ["ok", "warn", "danger", "info"] as const;

export default function DesignSystemPage() {
  return (
    <main className="mx-auto flex max-w-[var(--container-max)] flex-col gap-12 px-6 py-16">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark markSize={26} />
        <ThemeToggle />
      </header>

      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs uppercase tracking-mono-label text-fg-muted">
          design system · living showcase
        </p>
        <h1 className="max-w-[18ch] text-4xl font-semibold leading-tight tracking-display text-fg text-balance">
          One ink, four signals, zero accents.
        </h1>
        <p className="max-w-[60ch] text-md leading-body text-fg-secondary">
          Everything renders from the same tokens. Toggle the theme to watch the whole surface swap
          without a single recompiled class — light is the canonical brand, dark is a first-class
          product preference.
        </p>
      </div>

      <Section eyebrow="01 · color" title="The ink scale">
        <div className="overflow-hidden rounded-control border border-hairline">
          <div className="flex">
            {Object.entries(ink).map(([stop]) => (
              <div key={stop} className="flex-1">
                <div className="h-16" style={{ background: `var(--wh-ink-${stop})` }} />
                <div className="py-1.5 text-center font-mono text-[10px] text-fg-muted">{stop}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-sm text-fg-muted">
          A single cool-slate ramp carries the identity. There is no brand accent color: links are
          ink, the primary button is inverse ink.
        </p>

        <h3 className="text-lg font-semibold tracking-tight text-fg">Functional state</h3>
        <div className="flex flex-wrap gap-3">
          {STATES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill status="delivered" />
          <StatusPill status="retrying" />
          <StatusPill status="failed" />
          <StatusPill status="replayed" />
          <StatusPill status="pending" />
        </div>
      </Section>

      <Section eyebrow="02 · typography" title="One sans, one mono">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <div>
              <p className="text-4xl font-semibold leading-tight tracking-display text-fg">
                Webhooks that arrive.
              </p>
              <p className="font-mono text-[10px] text-fg-faint">display · 48 / 620 / -0.035em</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tracking-heading text-fg">
                Inspect every delivery
              </p>
              <p className="font-mono text-[10px] text-fg-faint">heading · 28 / 620 / -0.025em</p>
            </div>
            <div>
              <p className="max-w-[60ch] text-md leading-body text-fg-secondary">
                Every event is signature-verified at the edge and deduplicated before your code sees
                it. Failures retry for 72 hours.
              </p>
              <p className="font-mono text-[10px] text-fg-faint">body · 16 / 400 / 1.55</p>
            </div>
            <div>
              <p className="font-mono text-xs uppercase tracking-mono-label text-fg-muted">
                ingest · eyebrow label
              </p>
              <p className="font-mono text-[10px] text-fg-faint">
                eyebrow · 12 mono / +0.06em / uppercase
              </p>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="03 · components" title="Buttons & controls">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button>
                Start free <ArrowRight aria-hidden="true" />
              </Button>
              <Button variant="secondary">Read the docs</Button>
              <Button variant="ghost">View changelog</Button>
              <Button variant="danger">Delete endpoint</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button>Medium</Button>
              <Button size="lg">Large</Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="04 · components" title="Inputs & cards">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Add endpoint</CardTitle>
              <CardDescription>Where verified events get delivered.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="url">Delivery url</Label>
                <Input id="url" placeholder="https://api.example.com/webhooks" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="secret">Signing secret</Label>
                <Input id="secret" defaultValue="whsec_xxx" />
              </div>
              <Button>Save endpoint</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent deliveries</CardTitle>
              <CardDescription>Status carries color; nothing else does.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 font-mono text-sm text-fg-secondary">
              <div className="flex items-center justify-between">
                <span>evt_1Qx84K</span>
                <StatusPill status="delivered" />
              </div>
              <div className="flex items-center justify-between">
                <span>evt_1Qx84L</span>
                <StatusPill status="retrying" />
              </div>
              <div className="flex items-center justify-between">
                <span>evt_1Qx84M</span>
                <StatusPill status="failed" />
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section eyebrow="05 · motion" title="Swift by default">
        <Card>
          <CardContent className="pt-6">
            <MotionDemo />
          </CardContent>
        </Card>
        <p className="text-sm text-fg-muted">
          Product motion answers in 180 ms or less on decisive ease-out curves. Exits are faster
          than entrances, and reduced-motion is honored unconditionally.
        </p>
      </Section>
    </main>
  );
}
