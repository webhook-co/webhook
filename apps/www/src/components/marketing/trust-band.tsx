import { cn } from "@webhook-co/ui";
import { FileCheck, Layers, Lock } from "lucide-react";

import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { sectionPad } from "@/lib/styles";

const BADGES = [
  { icon: Lock, label: "Encryption in transit & at rest" },
  { icon: FileCheck, label: "Hash-chained audit log" },
  { icon: Layers, label: "Tenant isolation (RLS)" },
];

/**
 * The security/compliance band. This is an INVERSE-surface section (dark band on the light page) —
 * NOT a `data-theme="dark"` island like the terminal. The muted text/borders use the on-inverse ink
 * at reduced opacity (Tailwind `/NN` ≈ the mockup's `color-mix`), staying on-token.
 */
export function TrustBand() {
  return (
    <section
      aria-labelledby="trust-title"
      className={cn(
        "border-y border-fg-on-inverse/15 bg-surface-inverse text-fg-on-inverse",
        sectionPad,
      )}
    >
      <div className="mx-auto flex max-w-[760px] flex-col items-center px-6 text-center">
        <SectionEyebrow rule={false} className="mb-4 text-fg-on-inverse/60">
          security &amp; compliance
        </SectionEyebrow>
        <h2
          id="trust-title"
          className="mb-4 text-[clamp(24px,3.2vw,32px)] leading-[1.12] font-semibold tracking-heading"
        >
          Private by default, open at the core, and built for the audits that come later
        </h2>
        <p className="text-md text-pretty text-fg-on-inverse/75">
          Private-by-default capture, encryption in transit and at rest, a hash-chained audit log,
          and tenant isolation by row-level security, all designed in from the start. SOC 2 Type II
          and GDPR/DPA are near-term; a HIPAA BAA follows. The core engine, CLI, MCP server, and
          signing implementation are open source under Apache-2.0.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {BADGES.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-2 rounded-pill border border-fg-on-inverse/20 px-3 py-1.5 font-mono text-xs whitespace-nowrap text-fg-on-inverse/80"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
