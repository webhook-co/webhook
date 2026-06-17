"use client";

import { prefersReducedMotion } from "@webhook-co/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// useLayoutEffect warns when it runs during SSR; fall back to useEffect on the server. We need the
// layout variant on the client so the hidden state is committed before the browser paints.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface RevealState {
  /** Whether the hidden-then-animate-in treatment is active for this element. */
  armed: boolean;
  /** Whether the element has been revealed (or was shown immediately). */
  revealed: boolean;
}

/**
 * One-shot scroll reveal, built to be **additive** and blink-free:
 *
 * - The server HTML and first render carry no hidden class, so content is always visible up front and
 *   can never get stuck at `opacity:0` if JS fails.
 * - On mount we decide once. If the user prefers reduced motion, the `IntersectionObserver` API is
 *   missing, or the element is already on screen, we reveal immediately and never hide it — hiding a
 *   visible element would make it blink out and back.
 * - Only elements that start *below the fold* are armed (hidden off-screen) and then animated in when
 *   they scroll into view. The observer is one-shot: it disconnects after the first intersection.
 */
export function useScrollReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState<RevealState>({ armed: false, revealed: false });

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const supported = typeof IntersectionObserver !== "undefined";
    const belowFold = el.getBoundingClientRect().top >= window.innerHeight;

    if (prefersReducedMotion() || !supported || !belowFold) {
      setState({ armed: false, revealed: true });
      return;
    }

    setState({ armed: true, revealed: false });
    // No negative bottom margin: a short element that settles near the viewport bottom must still
    // fire (otherwise it could stay stuck at opacity:0). threshold 0.1 is enough of a delay.
    const observer = new IntersectionObserver(
      (entries) => {
        // One observed element ⇒ at most one entry per delivery, so check it directly (no loop).
        if (entries[0]?.isIntersecting) {
          setState({ armed: true, revealed: true });
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, armed: state.armed, revealed: state.revealed };
}
