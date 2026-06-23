# ADR 0055 — CLI in-tail TUI (interactive replay browser over the live tail) (D10)

- status: accepted (**D10** — `wbhk listen <endpoint>` on an interactive TTY hands off to an in-tail TUI:
  navigate the live event stream and replay/inspect on demand. The last Lane-D slice; the full TUI is the
  v1 target per the founder, 2026-06-22.).
- date: 2026-06-23
- scope: new `src/tui/` module (`keys.ts` decode, `state.ts` reducer, `render.ts` frame, `run.ts` runner
  controller) + tests; `commands/listen.ts` (a TTY-gated TUI hand-off + an additive `observe` hook on
  `runListen` + a `replaySelected` builder for the `r` key); new io seams `isTTY` / `terminalSize()` /
  `startRawInput()` (`context.ts` + `io.ts` + `makeTestContext`); `api-client.ts` (`resolveDashboardUrl`).
- relates: the shipped `wbhk listen` tunnel (ADR-0014) + the `replay --forward` path (ADR-0016) the `r`
  key reuses. `~/.claude/plans/cozy-greeting-cupcake.md` §D10. Lane D.
- review severity: medium-high (renders server-controlled event data to the terminal; `r` re-delivers a
  captured payload; `o` opens a browser; raw-mode terminal lifecycle). `/code-review` + `/security-review`
  (auth/abuse lens). Folded: a code MAJOR (a rejecting tunnel loop on the TUI branch could surface as an
  unhandled rejection — the `loop.finally(stop)` teardown branch now `.catch`es, so the real error rides
  `await loop` once); a security MINOR (the alt-screen was entered before the command's `try`, so an
  init-time render throw could leave the terminal in raw mode — `createTui` now self-restores on a startup
  failure before re-throwing); a security MINOR (the TUI retained every event unbounded — `appendEvent` now
  caps at `MAX_EVENTS` drop-oldest, like the bounded plain tail); plus defense-in-depth `encodeURIComponent`
  on the dashboard-URL id. **The rendered layout / colors / interaction are a human-UI hard stop (per the
  constitution): the pure logic is fully unit-tested, but a real-terminal eyeball is required before merge —
  this slice does NOT self-merge.**

## context

`wbhk listen` is the wedge's live tail. D10 turns it, on an interactive TTY, into an interactive replay
browser: a scrolling list of captured events you navigate with the arrows (and `j`/`k`), with `d` to open a
detail pane, `o` to open the selected event in the dashboard, and `r` to re-deliver it to the `--forward`
localhost target. Off a TTY (piped / non-interactive / CI) it falls back to the existing plain line tail,
unchanged. The challenge is keeping a stateful, raw-mode, redraw-on-event terminal program testable without
a terminal — and integrating it into `runListen`'s reconnect loop without entangling the two.

## decision

1. **The interaction model is pure; only the terminal is a seam.** `tui/` is split into pure, unit-tested
   functions — `decodeKey` (raw chunk → command), a `TuiState` reducer (`appendEvent` / `moveSelection` /
   `toggleDetail` / `setStatus` + a stateless bottom-anchored scroll `visibleWindow`), and `renderFrame`
   (state → the full text frame) — driven by a `run.ts` controller (`createTui`) that wires an injected
   `TuiTerminal` (write / size / raw-input subscribe) and injected effects (open-browser / replay). Raw-mode
   stdin, SIGWINCH, terminal size, and the alt-screen writes are the coverage-excluded `io.ts` seam; the
   runner is tested end-to-end with a fake terminal + fake effects.

2. **Width- and injection-safety in the renderer.** Every line is built as plain text from
   `sanitizeControl`-cleaned server values (provider / id / dedupKey / endpointId / status), hard-truncated
   to the terminal width FIRST, then color is painted onto whole-word `verified`/`unverified` tokens (SGR
   codes add no visible width, and a token cut by truncation no longer matches). So no rendered line — colored
   or not — exceeds the terminal width, and a hostile event value can't inject a terminal escape.

3. **The TUI runs the loop in INSPECTION mode, even with `--forward`.** A TUI is a browse-and-selectively-
   replay surface; auto-forwarding the whole stream (and firing a backlog at localhost the moment you open
   it) would defeat that. So in TUI mode `--forward` does NOT auto-deliver — it arms the `r` key, which
   re-delivers the SELECTED event on demand through the SAME validated loopback target + forwarder as the
   plain path (`parseForwardTarget` at command start; `forwardToLocalhost` re-validates loopback + uses
   `redirect: "manual"`; exact captured bytes + original `webhook-*` headers — no re-signing, ADR-0016).
   `r` with no `--forward` set just tells you to pass one. *(This is the one behavior fork to eyeball: it's a
   deliberate interactive-vs-scripted distinction, flagged on the PR.)*

4. **`runListen` feeds the TUI via one additive `observe` hook.** A new optional `observe(summary)` fires
   once per newly-seen event (inside the existing `!seen` dedup guards, both modes) — the TUI's only new
   coupling to the loop. In TUI mode the per-line `emit` is dropped (the list IS the display) and `note`
   (tunnel notices / caught-up / backlog guard) routes to the status line. Quit (`q` / Ctrl-C, which raw
   mode delivers as a key) tears down the TUI and aborts the loop; the loop ending on its own closes the TUI.

5. **The terminal is restored on every path.** `createTui` self-restores (close raw input → cooked mode;
   show cursor; leave alt-screen) if its own startup render throws, then re-throws. The command's
   `try/finally` calls `tui.stop()` (idempotent) on user-quit, loop-error, or any throw, guaranteeing the
   screen is restored before control returns. The `r` replay is guarded by an in-flight flag (no concurrent
   replays); `o` builds `${dashboard}/events/${encodeURIComponent(id)}` (https-only `resolveDashboardUrl`,
   spawned without a shell).

## consequences

- `wbhk listen <endpoint>` on a TTY is now an interactive browser: arrow/`j`/`k` to navigate, `d` detail,
  `o` open in the dashboard, `r` replay the selected event to `--forward`, `q`/Ctrl-C to quit — falling back
  to the plain tail off-TTY (scripts/pipes/CI unaffected).
- No new dependency, no new API scope; the `r` path reuses the existing replay primitives, and the retained
  event list is bounded (`MAX_EVENTS`) like the plain tail.
- The dashboard deep-link path (`/events/<id>`) is a best-guess pending Lane E's actual dashboard route —
  overridable via `WBHK_DASHBOARD_URL`; flagged for confirmation on the PR.
- The visual/interaction layer is unverified in CI (coverage-excluded seam): the state/render/key/runner
  logic is fully unit-tested, but the rendered experience needs a human terminal eyeball — this slice is
  founder-gated, not self-merged.

## alternatives considered

- **Ship only the single-key `r` hotkey (the minimum subset), defer the full TUI.** Rejected — the founder
  set the full TUI as the v1 target (2026-06-22). `r` alone is in the box; the browser is the deliverable.
- **Auto-forward in TUI mode too (consistent `--forward` semantics across TTY / non-TTY).** Rejected — it
  contradicts the browse-and-replay purpose and risks the backlog "side-effect cannon" the moment you open
  the TUI. The interactive/scripted fork is the better default (and is flagged for the eyeball).
- **Feed the TUI by intercepting `emit` (the formatted line) instead of a structured `observe`.** Rejected —
  the TUI needs the structured `EventSummary` (to replay / open / detail), not a pre-rendered string.
- **A diffing/partial-redraw renderer.** Rejected as over-engineering for v1 — a full-frame redraw on each
  event/keypress is simple, pure, and snapshot-testable; the event volume a human watches is modest.
