import { cn } from "@webhook-co/ui";

import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { sectionPad } from "@/lib/styles";

export function Manifesto() {
  return (
    <section
      aria-labelledby="manifesto-title"
      className={cn("border-y border-hairline bg-surface", sectionPad)}
    >
      <div className="mx-auto max-w-[760px] px-6 text-center">
        <SectionEyebrow rule={false} className="mb-4">
          the idea
        </SectionEyebrow>
        <h2
          id="manifesto-title"
          className="mb-5 text-[clamp(26px,4vw,38px)] leading-[1.12] font-semibold tracking-heading text-fg"
        >
          A webhook is an event, not a mystery
        </h2>
        <p className="mx-auto mb-3 max-w-[56ch] text-lg text-pretty text-fg-secondary">
          You should be able to see exactly what arrived, replay it whenever you want, and trust
          that it verified. Then hand it to an agent to act on.
        </p>
        <p className="mx-auto mb-3 max-w-[56ch] text-lg text-pretty text-fg-secondary">
          From the CLI, the API, the dashboard, or MCP, you get the same operations everywhere.
          Nothing public unless you say so.
        </p>
        <p className="mt-5 font-medium text-fg">That's the whole idea.</p>
      </div>
    </section>
  );
}
