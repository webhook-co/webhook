import { Card, CardContent, CardHeader, CardTitle } from "@webhook-co/ui";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

import type { AttentionItem } from "@/lib/dashboard-attention";

// The "needs attention" panel: failures rendered as resolvable objects, each a link to the page that fixes
// it. Rendered ONLY when there's something to flag (the page skips it on an empty list), so a healthy account
// sees a clean overview, not an empty "all good" box. Tone (danger/warn) maps to the shared functional
// colours; the dot is decorative (aria-hidden) — the title carries the meaning.

const toneDot: Record<AttentionItem["tone"], string> = {
  danger: "bg-danger",
  warn: "bg-warn",
};

export function NeedsAttention({ items }: { items: readonly AttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-0">
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.kind}>
              <Link
                href={item.href}
                className="relative flex items-start gap-3 border-t border-hairline px-6 py-3 transition-colors hover:bg-surface-sunken focus-visible:z-10 focus-visible:rounded-[2px] focus-visible:outline-none focus-visible:shadow-[var(--wh-focus-ring)]"
              >
                <span
                  className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${toneDot[item.tone]}`}
                  aria-hidden
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-fg">{item.title}</span>
                  <span className="text-sm text-fg-secondary">{item.description}</span>
                </span>
                <ChevronRight
                  className="ml-auto mt-0.5 size-4 shrink-0 text-fg-faint"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
