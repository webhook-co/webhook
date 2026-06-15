import type { ReactNode } from "react";

import { SectionEyebrow } from "@/components/ui/section-eyebrow";

/**
 * The centered eyebrow + h2 + lede header shared by the full-width feature sections (the live
 * inspector and the surfaces tabs), so their heading scale and measure stay locked together. The
 * `id` wires the heading to its section's `aria-labelledby`.
 */
export function SectionHeading({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto mb-8 max-w-[640px] text-center">
      <SectionEyebrow rule={false} className="mb-4 justify-center">
        {eyebrow}
      </SectionEyebrow>
      <h2
        id={id}
        className="mb-4 text-[clamp(26px,4vw,38px)] leading-[1.12] font-semibold tracking-heading text-fg"
      >
        {title}
      </h2>
      <p className="mx-auto max-w-[52ch] text-lg text-pretty text-fg-secondary">{children}</p>
    </div>
  );
}
