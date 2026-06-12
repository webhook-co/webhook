"use client";

import { Button, StatusPill } from "@webhook-co/ui";
import { fadeInUp, productTransition } from "@webhook-co/ui/motion";
import * as motion from "motion/react-client";
import { useReducedMotion } from "motion/react";
import { useState } from "react";

const STEPS = [
  { status: "delivered" as const, label: "received" },
  { status: "delivered" as const, label: "verified" },
  { status: "replayed" as const, label: "→ agent" },
];

/**
 * A small, on-brand product animation: a staggered reveal of an event moving through
 * the pipeline. Respects reduced-motion (resolves instantly, no stagger) and offers a
 * replay control — fast, decisive, no bounce.
 */
export function MotionDemo() {
  const reduce = useReducedMotion();
  const [run, setRun] = useState(0);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <motion.div
        key={run}
        className="flex flex-wrap items-center gap-2"
        initial={reduce ? false : "hidden"}
        animate="show"
        transition={{ staggerChildren: reduce ? 0 : 0.12 }}
      >
        {STEPS.map((step) => (
          <motion.div
            key={step.label}
            variants={{ hidden: fadeInUp.initial, show: fadeInUp.animate }}
            transition={productTransition}
          >
            <StatusPill status={step.status}>{step.label}</StatusPill>
          </motion.div>
        ))}
      </motion.div>

      <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
        Replay
      </Button>
    </div>
  );
}
