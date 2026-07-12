"use client";

import { cn } from "@webhook-co/ui";
import { animate } from "motion";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FaqItem } from "@/components/marketing/faq";
import { focusRing, proseLink } from "@/lib/styles";

/**
 * The FAQ accordion, animated with motion — smooth on the way open AND on the way closed.
 *
 * WHY THIS IS A CLIENT ISLAND, AND ONLY THIS. The section, the heading, and the FAQPage JSON-LD stay
 * in the server component: the structured data is what an answer engine reads, and it has no business
 * depending on hydration. Only the list — the thing that actually animates — ships JavaScript.
 *
 * WHY THE `open` ATTRIBUTE IS DRIVEN IMPERATIVELY. A native <details> hides its children the instant
 * `open` goes false, so there is nothing left to animate out — a CSS-only accordion can fade IN and
 * can only ever snap SHUT. To animate the close, the element has to stay open until the animation
 * finishes. So the summary's default toggle is prevented, this component owns which panel is open,
 * and it sets `details.open` on the DOM node itself: React never renders `open`, so React and the
 * browser can't fight over it mid-animation.
 *
 * PROGRESSIVE ENHANCEMENT IS PRESERVED. The markup is still <details>/<summary> with `name={group}`,
 * so before hydration — and with JavaScript off entirely — the accordion still works, still opens and
 * closes, and the browser still enforces one-open-at-a-time. The animation is the enhancement; the
 * behaviour is not.
 *
 * REDUCED MOTION IS HONOURED. `prefers-reduced-motion` skips the animation and toggles instantly. It
 * is checked at TOGGLE time, not once at mount, so someone who changes the OS setting mid-session
 * gets what they asked for without a reload.
 */
export function FaqList({
  items,
  group,
  openFirst = false,
}: {
  items: readonly FaqItem[];
  group: string;
  openFirst?: boolean;
}) {
  // Exclusive: at most one open. On /pricing the first panel starts open — it is the billable unit,
  // which the constitution requires be readable without a click. Everywhere else: all closed.
  const [openQuestion, setOpenQuestion] = useState<string | null>(
    openFirst ? (items[0]?.question ?? null) : null,
  );

  const toggle = useCallback((question: string) => {
    setOpenQuestion((current) => (current === question ? null : question));
  }, []);

  return (
    <div className="mx-auto max-w-[820px]">
      {items.map((item, index) => (
        <FaqEntry
          key={item.question}
          item={item}
          group={group}
          // Rendered into the STATIC HTML, so the panel is open for a crawler and for a reader with no
          // JavaScript — `open` is otherwise only ever set imperatively by the effect below, which
          // means the served markup would ship it CLOSED and the billable unit would sit behind a
          // click for exactly the readers who can't click. It never changes after the first render, so
          // React and the imperative handle can't fight over it.
          defaultOpen={openFirst && index === 0}
          isOpen={openQuestion === item.question}
          onToggle={() => toggle(item.question)}
        />
      ))}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function FaqEntry({
  item,
  group,
  defaultOpen,
  isOpen,
  onToggle,
}: {
  item: FaqItem;
  group: string;
  /** Rendered into the static markup — the pre-hydration / no-JS state. Never changes. */
  defaultOpen: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const details = detailsRef.current;
    const panel = panelRef.current;
    if (!details || !panel) return;

    // On mount, just reflect the state — never animate a panel the reader didn't touch.
    if (firstRender.current) {
      firstRender.current = false;
      details.open = isOpen;
      return;
    }

    if (prefersReducedMotion()) {
      details.open = isOpen;
      return;
    }

    let cancelled = false;

    if (isOpen) {
      // Open first, THEN measure: a closed <details> reports a height of 0 for its children.
      details.open = true;
      const target = panel.scrollHeight;
      animate(
        panel,
        { height: [0, target], opacity: [0, 1] },
        { duration: 0.28, ease: [0.32, 0.72, 0, 1] },
      ).then(() => {
        // Hand height back to the layout, or the panel can't reflow (a longer answer, a resize).
        if (!cancelled) panel.style.height = "auto";
      });
    } else {
      const from = panel.scrollHeight;
      animate(
        panel,
        { height: [from, 0], opacity: [1, 0] },
        { duration: 0.22, ease: [0.4, 0, 1, 1] },
      ).then(() => {
        // Only now is it safe to actually close: until the animation lands, the content must remain
        // in the DOM and laid out, or there is nothing to animate.
        if (cancelled) return;
        details.open = false;
        panel.style.height = "";
        panel.style.opacity = "";
      });
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return (
    <details
      ref={detailsRef}
      name={group}
      // Rendered into the STATIC markup, so the panel is open for a crawler and for a reader with no
      // JavaScript. `open` is otherwise only ever set imperatively by the effect above — which would
      // ship the served HTML with everything CLOSED, putting the billable unit behind a click for
      // exactly the readers who cannot click. Constant after first render, so React and the imperative
      // handle never fight over it.
      open={defaultOpen}
      className="group border-b border-hairline last:border-0"
    >
      <summary
        // The browser's own toggle is prevented so the close can be animated (see the file comment).
        // Without JS this handler never runs and the native toggle takes over — which is the point.
        onClick={(e) => {
          e.preventDefault();
          onToggle();
        }}
        className={cn(
          focusRing,
          "flex cursor-pointer list-none items-center justify-between gap-4 rounded-control py-5 font-medium text-fg",
          // Safari draws its own disclosure triangle unless this is cleared.
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        {item.question}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </summary>

      {/* `overflow-hidden` is what makes a height animation read as a reveal rather than a squash. */}
      <div ref={panelRef} className="overflow-hidden">
        <div className="pb-5">
          <p className="max-w-[68ch] leading-relaxed text-fg-secondary">{item.answer}</p>
          {item.link ? (
            <a href={item.link.href} className={cn(proseLink, "mt-3 inline-block")}>
              {item.link.label}
            </a>
          ) : null}
        </div>
      </div>
    </details>
  );
}
