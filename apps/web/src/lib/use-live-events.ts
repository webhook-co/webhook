"use client";

import type { Lag } from "@webhook-co/shared";
import * as React from "react";

import type { EventSummaryItem } from "@/server/events";

import {
  createLiveEventsSession,
  type LiveConnectionStatus,
  type MintTicketResult,
  type WebSocketCtor,
} from "./live-events";

// React wrapper over the pure live-events core. It owns enable/disable, prepends arrived events into the
// caller's list setter (DEDUPING by id so a live event that later shows up in a page load isn't doubled),
// tracks the connection + cursor-contract status for the UI indicator, and AUTO-PAUSES when the tab is
// hidden or the component unmounts — a background tab shouldn't hold an open socket or pile up rows the
// user isn't watching. The tail is read-only; it never mutates data and never meters.

export interface UseLiveEventsOptions {
  /** The user's Live toggle. `false` tears the socket down. */
  readonly enabled: boolean;
  /** The `wss://…/listen` URL (derived server-side; passed through as a prop). */
  readonly wsUrl: string;
  /** The endpoint to tail, or OMITTED for an org-wide tail (the consolidated events page). */
  readonly endpointId?: string;
  /** The session-authed mint action, scope-agnostic + pre-bound (a stable RSC-passed server-action ref). */
  readonly mintTicket: () => Promise<MintTicketResult>;
  /** The list-state setter the live tail prepends into (dedup happens here). */
  readonly setItems: React.Dispatch<React.SetStateAction<readonly EventSummaryItem[]>>;
  /** Injected for tests (a FakeWebSocket); defaults to the browser `WebSocket`. */
  readonly WebSocketCtor?: WebSocketCtor;
}

export interface LiveEventsState {
  /** Coarse connection state for the indicator. `disconnected` covers paused/off and reconnecting. */
  readonly connection: LiveConnectionStatus;
  /** Whether the tail is caught up to the head (false → showing `backlogCount` behind). */
  readonly caughtUp: boolean;
  /** The capped backlog lag, when the engine reports one. */
  readonly lag: Lag | undefined;
  /** An unobtrusive reason the stream couldn't start (cleared once it connects); null when fine. */
  readonly error: string | null;
}

/**
 * How long a paused tail may resume from its cursor before it is treated as a NEW go-live.
 *
 * A pause is an interruption — a tab switch, a screen lock, a five-minute meeting — and resuming exactly is
 * right for those: the events arrived while Live was on, so they are not history. A long absence is a
 * different thing wearing the same clothes: without a bound the ref survives indefinitely and a Friday-evening
 * Live toggle resumes on Monday by draining the whole weekend into the list — the exact history-replay this
 * feature exists to prevent.
 *
 * This bound covers the VISIBILITY path (a hide/show re-runs the connect effect) — the common sleep/lock,
 * which fires visibilitychange. A suspend that does NOT fire it leaves the socket to die and reconnect with
 * the sticky sessionId, and the DO then replays the gap from its durable cursor; bounding THAT — capping how
 * much of a long suspend replays — still needs a server-side liveness signal the protocol does not have. The
 * ReadyFrame seed cursor (#25) is a DIFFERENT fix on a DIFFERENT axis: it gives the visibility path a resume
 * position from connect (before the first event, so a hide-before-first-event pause is lossless), but it does
 * not add that liveness signal, so the suspend-replay bound remains future work.
 *
 * 5 minutes is a judgement call, not a derivation: long enough that every real interruption resumes
 * losslessly, short enough that no plausible backlog is a flood. Tune it here if it reads wrong in practice.
 *
 * Measured with `Date.now()` deltas ON PURPOSE: it is a DURATION on one clock, so server skew cannot touch it,
 * and unlike `performance.now()` the wall clock keeps advancing while the machine sleeps — which is precisely
 * the case being bounded.
 */
export const LIVE_RESUME_MAX_PAUSE_MS = 5 * 60 * 1000;

/** Read the document's current visibility (SSR-safe: treat a missing `document` as visible). */
function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function useLiveEvents({
  enabled,
  wsUrl,
  endpointId,
  mintTicket,
  setItems,
  WebSocketCtor,
}: UseLiveEventsOptions): LiveEventsState {
  const [connection, setConnection] = React.useState<LiveConnectionStatus>("disconnected");
  const [caughtUp, setCaughtUp] = React.useState(true);
  const [lag, setLag] = React.useState<Lag | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(true);

  // Track tab visibility so a hidden tab pauses the tail (no open socket, no piled-up rows).
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(isDocumentVisible());
    setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Prepend + dedup by id: a live event already present in the list (e.g. it also arrived via a page load)
  // is not re-added; a genuinely new one goes to the top.
  //
  // Deliberately NOT capped by slicing the array. `items` is SHARED with pagination — "Load older" APPENDS
  // rows at the tail — so a head-keeping `slice(0, N)` would silently evict the rows the user deliberately
  // paged in, leaving a non-refetchable gap (the pager's cursor already sits past them). A Set-based O(1)
  // dedup can't replace `.some(prev)` either: the Set the hook owns is blind to those paginated rows, so it
  // would re-prepend a live duplicate of one. The dedup MUST scan the full `prev` (all sources), and that is
  // the only correct bound available here. Growth is bounded in practice by the hidden-tab auto-pause + the
  // realistic org event rate; if a true blowup is ever measured, a correct cap must track live-vs-anchored
  // rows rather than slice the shared array.
  const handleEvent = React.useCallback(
    (item: EventSummaryItem) => {
      setItems((prev) => (prev.some((e) => e.id === item.id) ? prev : [item, ...prev]));
    },
    [setItems],
  );

  const active = enabled && visible;

  /**
   * The resume position across a PAUSE — seeded at CONNECT, then advanced by each delivered event.
   *
   * It is initialized from the ReadyFrame's `cursor` (#25): the DO reports the opaque position it actually
   * seeded/persisted at, so this ref is non-null from connect — BEFORE the first event — and each delivered
   * event then advances it (the `onCursor` wiring below, fed by both the ready arm and the event arm in
   * live-events.ts). That CLOSES the hide-before-first-event gap: a tab that hid before any event arrived used
   * to have no cursor, so the resume fell back to `since=now` and silently skipped whatever landed while
   * hidden. It now resumes from the seed instead.
   *
   * The seed is SERVER-resolved (the DO's persisted position), never a client-side `new Date()` — a laptop
   * clock minutes off would otherwise silently skip or replay minutes of events. The ReadyFrame field is
   * optional + nullable, so a `null`/absent seed (a session that started from the oldest, or an engine that
   * predates #25) simply leaves this null until the first event, exactly as before — no regression.
   *
   * A ref, not state: it must survive the effect teardown/re-run that a visibility change causes, and writing
   * it must not re-render (every event would).
   */
  const lastCursorRef = React.useRef<string | null>(null);

  /**
   * Turning Live OFF ends the live intent, so the next ON is a FRESH one: `since=now`, no history. Dropping
   * the cursor here is what encodes that — without it, toggling off, waiting an hour and toggling on would
   * replay the hour, which is the history-replay the whole change removes.
   *
   * Hiding the TAB is deliberately not this. `enabled` stays true, the cursor survives, and coming back
   * resumes exactly — those events arrived while Live was on, so they are not history.
   */
  React.useEffect(() => {
    if (!enabled) lastCursorRef.current = null;
  }, [enabled]);

  /** When the tail last went inactive, so a resume can tell an interruption from an absence. */
  const pausedAtRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (active) {
      // Resuming: a pause older than the bound is not a pause. Drop the cursor so the connect below asks for
      // `since=now` and the reader starts watching again rather than replaying however long they were away.
      const pausedAt = pausedAtRef.current;
      if (pausedAt !== null && Date.now() - pausedAt > LIVE_RESUME_MAX_PAUSE_MS) {
        lastCursorRef.current = null;
      }
      pausedAtRef.current = null;
    } else {
      pausedAtRef.current = Date.now();
    }
  }, [active]);

  React.useEffect(() => {
    if (!active) {
      setConnection("disconnected");
      return;
    }
    // Reset the status readout on a fresh connect so a stale "N behind" / error doesn't linger.
    setCaughtUp(true);
    setLag(undefined);
    setError(null);
    const session = createLiveEventsSession({
      wsUrl,
      endpointId,
      mintTicket,
      onEvent: handleEvent,
      onStatus: (s) => {
        setCaughtUp(s.caughtUp);
        setLag(s.lag);
      },
      onConnectionChange: (c) => {
        setConnection(c);
        // A live connection clears any earlier "couldn't start" notice.
        if (c === "connected") setError(null);
      },
      onError: setError,
      // Absent on a fresh go-live (⇒ `since=now`); set when resuming a paused tail (⇒ `sinceCursor=`).
      // Read at connect time, so the effect deps stay unchanged and a visibility flip does not re-key it.
      seedFrom: lastCursorRef.current ?? undefined,
      onCursor: (c) => (lastCursorRef.current = c),
      WebSocketCtor,
    });
    return () => session.stop();
  }, [active, wsUrl, endpointId, mintTicket, handleEvent, WebSocketCtor]);

  return { connection, caughtUp, lag, error };
}
