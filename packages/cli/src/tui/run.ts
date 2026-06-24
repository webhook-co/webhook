// The in-tail TUI runner: wires a raw-mode terminal to the pure state/render/keys core. It owns the
// alt-screen lifecycle (enter on start, restore on quit), turns each decoded keypress into a state
// transition or an effect (replay/open), and feeds in live events via the controller. Everything
// host-touching is behind the injected TuiTerminal + TuiEffects, so the whole runner is unit-tested
// with fakes; the real terminal (raw stdin + SIGWINCH + restore) is the coverage-excluded io seam.

import type { EventSummary } from "@webhook-co/shared";

import { decodeKey } from "./keys.js";
import { renderFrame } from "./render.js";
import {
  appendEvent,
  initialState,
  moveSelection,
  selectedEvent,
  setStatus,
  toggleDetail,
  type TuiState,
} from "./state.js";

/** The raw-mode terminal the runner drives — write a frame, read its size, subscribe to input. */
export interface TuiTerminal {
  write(s: string): void;
  size(): { columns: number; rows: number };
  /** Begin delivering decoded key chunks + resize notices; the returned handle restores cooked mode. */
  start(handlers: TuiInputHandlers): { close(): void };
}
export interface TuiInputHandlers {
  onKey(chunk: string): void;
  onResize(): void;
}

/** The side effects the action keys trigger, injected so the runner stays host-free. */
export interface TuiEffects {
  /** Build the dashboard URL for an event (the `o` key opens it). */
  dashboardUrl(e: EventSummary): string;
  /** Open a URL in the browser (best-effort). */
  openBrowser(url: string): Promise<void>;
  /** Re-deliver the event to the `--forward` target (the `r` key); undefined when no `--forward` was
   *  given — `r` then just tells the user to set one. */
  replay?: (e: EventSummary) => Promise<{ ok: boolean; message: string }>;
}

export interface TuiDeps {
  readonly terminal: TuiTerminal;
  readonly effects: TuiEffects;
  readonly color: boolean;
}

/** The handle the command holds: feed events/notes in, force-stop, and await the user quitting. */
export interface TuiController {
  /** Add a newly-arrived event to the list. */
  pushEvent(e: EventSummary): void;
  /** Surface a one-line status (e.g. a tunnel notice) without disturbing the list. */
  note(message: string): void;
  /** Tear down and resolve `finished` (e.g. the tunnel loop ended); idempotent. */
  stop(): void;
  /** Resolves once the TUI has torn down (user quit, or stop()). */
  readonly finished: Promise<void>;
}

// Alt-screen + cursor control. Built from the ESC byte by code so the source stays plain ASCII.
const ESC = String.fromCharCode(27);
const ENTER_ALT = `${ESC}[?1049h`;
const LEAVE_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const HOME_CLEAR = `${ESC}[H${ESC}[2J`; // cursor home + clear screen

/** Rows of fixed chrome (title + blank + blank-before-footer + footer); the rest is the list viewport. */
const CHROME_ROWS = 4;
/** Extra rows the detail pane occupies (a blank + the detail block). */
const DETAIL_ROWS = 9;

export function createTui(deps: TuiDeps): TuiController {
  const { terminal, effects, color } = deps;
  let state: TuiState = initialState(listRows(false));
  let closed = false;
  let replaying = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  function listRows(detail: boolean): number {
    const { rows } = terminal.size();
    return Math.max(1, rows - CHROME_ROWS - (detail ? DETAIL_ROWS : 0));
  }

  function render(): void {
    if (closed) return;
    // Re-fit the list viewport to the current terminal height + whether the detail pane is open.
    state = { ...state, viewportRows: listRows(state.detail) };
    try {
      terminal.write(HOME_CLEAR + renderFrame(state, { color, columns: terminal.size().columns }));
    } catch {
      // stdout broke mid-session (EPIPE — the terminal/pipe closed). Tear down + stop rather than let the
      // write throw out of a key/resize handler as an unhandled error (don't rely only on the global hook).
      teardown();
    }
  }

  function teardown(): void {
    if (closed) return;
    closed = true;
    handle.close();
    // Best-effort restore — if stdout is already broken this throws; swallow it (cooked mode is restored
    // by handle.close(), which is what matters), so teardown never throws back into a caller (incl. render).
    try {
      terminal.write(SHOW_CURSOR + LEAVE_ALT);
    } catch {
      /* stdout already broken; cooked mode is restored above */
    }
    resolveFinished();
  }

  function doReplay(): void {
    const e = selectedEvent(state);
    if (e === undefined) return;
    if (effects.replay === undefined) {
      state = setStatus(state, "replay needs --forward <localhost-url>");
      render();
      return;
    }
    if (replaying) return; // one in flight — ignore until it resolves
    replaying = true;
    state = setStatus(state, `replaying ${e.id}…`);
    render();
    void effects
      .replay(e)
      .then((r) => setStatus(state, r.message))
      .catch((err: unknown) =>
        setStatus(state, `replay failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .then((next) => {
        replaying = false;
        state = next;
        render();
      });
  }

  function doOpen(): void {
    const e = selectedEvent(state);
    if (e === undefined) return;
    state = setStatus(state, `opening ${e.id} in your browser…`);
    render();
    void effects.openBrowser(effects.dashboardUrl(e)).catch(() => {
      state = setStatus(state, "could not open the browser");
      render();
    });
  }

  function dispatch(chunk: string): void {
    if (closed) return;
    switch (decodeKey(chunk)) {
      case "up":
        state = moveSelection(state, -1);
        return render();
      case "down":
        state = moveSelection(state, 1);
        return render();
      case "detail":
        state = toggleDetail(state);
        return render();
      case "replay":
        return doReplay();
      case "open":
        return doOpen();
      case "quit":
        return teardown();
      case "none":
        return;
    }
  }

  const handle = terminal.start({ onKey: dispatch, onResize: render });
  // Entering the alt-screen + the first render happen here, BEFORE the command's try/finally. If either
  // throws (e.g. a racing stdout EPIPE), restore the terminal ourselves so a startup failure can't leave
  // it in raw mode / alt-screen, then re-throw for the caller to surface.
  try {
    terminal.write(ENTER_ALT + HIDE_CURSOR);
    render();
  } catch (err) {
    closed = true;
    handle.close(); // the critical restore: cooked mode back
    try {
      terminal.write(SHOW_CURSOR + LEAVE_ALT);
    } catch {
      /* stdout already broken — cooked mode is restored, which is what matters */
    }
    resolveFinished();
    throw err;
  }

  return {
    pushEvent(e) {
      if (closed) return;
      state = appendEvent(state, e);
      render();
    },
    note(message) {
      if (closed) return;
      state = setStatus(state, message);
      render();
    },
    stop: teardown,
    finished,
  };
}
