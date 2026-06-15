import { cn } from "@webhook-co/ui";
import { Bot, Braces, History, ShieldCheck, Terminal, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { focusRing } from "@/lib/styles";

const RESOURCES: { icon: typeof Zap; title: string; line: ReactNode }[] = [
  { icon: Zap, title: "Quickstart", line: "Capture your first event in a minute." },
  { icon: Bot, title: "MCP server", line: "Wire webhooks into your agents." },
  {
    icon: Terminal,
    title: "CLI reference",
    line: (
      <>
        <span className="font-mono">wbhk</span> commands, end to end.
      </>
    ),
  },
  { icon: Braces, title: "API reference", line: "Endpoints, events, replay." },
  { icon: ShieldCheck, title: "Standard Webhooks", line: "How we sign and verify." },
  { icon: History, title: "Changelog", line: "What shipped this week." },
];

export function Resources() {
  return (
    <section
      aria-labelledby="resources-title"
      className="mx-auto max-w-[880px] px-6 pt-[clamp(44px,5.5vw,76px)] pb-[clamp(84px,9vw,120px)] text-center"
    >
      <div className="flex flex-col items-center">
        <SectionEyebrow rule={false} className="mb-3">
          resources
        </SectionEyebrow>
        <h2
          id="resources-title"
          className="text-[clamp(28px,4vw,36px)] leading-[1.08] font-semibold tracking-heading text-fg"
        >
          Start where it makes sense for you
        </h2>
      </div>
      <div className="mt-10 grid grid-cols-3 gap-4 max-[940px]:grid-cols-2 max-[560px]:grid-cols-1">
        {RESOURCES.map(({ icon: Icon, title, line }) => (
          <a
            key={title}
            href="#"
            className={cn(
              focusRing,
              "group flex flex-col items-center gap-[5px] rounded-card border border-hairline bg-surface px-4 py-6 text-center shadow-1 transition-[box-shadow,transform,border-color] duration-150 ease-swift hover:-translate-y-[3px] hover:border-strong hover:shadow-3",
            )}
          >
            <span className="mb-2 grid h-11 w-11 place-items-center rounded-control border border-hairline bg-surface-sunken text-fg-secondary transition-colors duration-150 ease-swift group-hover:border-transparent group-hover:bg-surface-inverse group-hover:text-fg-on-inverse">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-md font-semibold tracking-tight text-fg">{title}</span>
            <span className="text-sm leading-[1.45] text-pretty text-fg-muted">{line}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
