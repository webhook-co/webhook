"use client";

import { useCallback, useEffect, useReducer, useState } from "react";

import { useReducedMotion } from "@/lib/use-reduced-motion";
import { advance, INITIAL_STATE, type StreamState } from "./stream-engine";

/** How long between new events. Literal, not a token — the duration tokens cap at 420ms. */
const DEFAULT_INTERVAL_MS = 2600;

function reducer(state: StreamState, action: "tick"): StreamState {
  return action === "tick" ? advance(state) : state;
}

export interface LiveStream {
  state: StreamState;
  /** The user's play intent. The stream also pauses while the tab is hidden, without changing this. */
  isPlaying: boolean;
  /** Flip play/pause. A manual pause survives a tab switch (visibility never mutates intent). */
  toggle: () => void;
}

/**
 * Drives the inspector stream. The reducer (the pure engine) is the only mutation path; this hook
 * just owns the side effects: the tick interval, tab-visibility pausing, and the reduced-motion
 * default. Render reads only `INITIAL_STATE`, so the first client paint matches the server HTML.
 */
export function useLiveStream(intervalMs: number = DEFAULT_INTERVAL_MS): LiveStream {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  // Optimistically playing — identical on the server and first client render. Reduced-motion users
  // are flipped to paused in the effect below (post-mount), which they can override with the button.
  const [playing, setPlaying] = useState(true);
  const [hidden, setHidden] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) setPlaying(false);
  }, [reduced]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setHidden(document.hidden);
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // The interval exists only while effectively running. Keyed on play/visibility so it tears down and
  // rebuilds rather than stacking, and so a hidden tab genuinely stops ticking.
  useEffect(() => {
    if (!playing || hidden) return;
    const id = setInterval(() => dispatch("tick"), intervalMs);
    return () => clearInterval(id);
  }, [playing, hidden, intervalMs]);

  const toggle = useCallback(() => setPlaying((p) => !p), []);

  return { state, isPlaying: playing, toggle };
}
