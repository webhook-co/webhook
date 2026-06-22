# ADR 0043 — `wbhk listen` cross-run resume + the status banner

- status: accepted (**D6b** — wires the D6a cursor store into `listen` + surfaces the StatusFrame. The
  O_EXCL single-listener lock and `--no-resume` are intentionally deferred — see alternatives).
- date: 2026-06-22
- scope: `packages/cli/src/commands/listen.ts` (`resolveResumeStart` [new, exported], a `persist?` dep on
  `runListen`, the StatusFrame banner replacing the prior skip, the `--resume`/`--reset` flags + the
  `--since from-last-ack` spelling, the serialized persist chain in the handler) + `listen.test.ts`.
  Consumes `state/cursor-store.ts` (D6a) + `resolveStateDir` (D5).
- relates: ADR-0042 (the cursor store this consumes), ADR-0014 (the listen tunnel), ADR-0017 (the
  StatusFrame contract this now renders). `internal/build-plans/lane-d-cli.md` §D6. Lane D (`packages/cli`).
- review severity: medium-high (modifies the delicate reconnect loop). One code review + one security
  red-team — security SHIP (no findings); the code review's MINOR (persisting after a no-op ack / on a
  redelivery could move the saved cursor backwards) was folded into a stronger fix (persist new events
  only, monotonic) and locked with a test.

## context

`wbhk listen` resumes within a run (sessionId reuse + the engine's durable cursor) but had no cross-run
memory, and it silently skipped the server's StatusFrame (caught-up / backlog lag). D6a shipped the cursor
store; this slice wires it in and renders the status signal, completing D6.

## decision

1. **`resolveResumeStart` — where a run starts, with resume folded in.** `--reset` forgets the saved
   cursor first. Resume (`--resume`, or the `--since from-last-ack` spelling) loads the persisted OPAQUE
   cursor → resume via `?sinceCursor=`; a miss or a corrupt file cold-starts from "now" (warning on
   corrupt) so a damaged state file never wedges the tail. Otherwise the existing now|beginning|<cursor>
   mapping. fs is injected (loadCursor/clearCursor) so it's unit-tested without disk.

2. **Persist only NEWLY-seen cursors → monotonic resume.** `runListen` gains a `persist?` dep, called
   **inside the `!seen` guard** in both inspection and forward modes (after the event is printed /
   forwarded+recorded). New events arrive in order, so the saved cursor advances monotonically; a
   redelivery still re-acks (to advance the server) but must NOT re-persist an older cursor — that would
   move the resume point backwards and re-deliver already-seen events on the next run. The handler
   serializes the writes (`persistChain = persistChain.then(saveCursor).catch(note)`) so the last-acked
   cursor is the last write, a failed write degrades to a noted warning (never fatal), and the chain is
   drained in `finally` so the final position is durable on a clean Ctrl-C. Persistence is on only when
   resume is on, so a plain `listen` writes nothing.

3. **The StatusFrame becomes a stderr banner.** `caughtUp` → a one-time "caught up" note (re-armed when
   the tail falls behind again); a backlog at/above `BACKLOG_GUARD` (1,000, tunable, well below the server
   `LISTEN_LAG_CAP`) → an "N events behind — replaying the backlog" heads-up (the "side-effect cannon"
   warning, esp. with `--forward`), with an over-cap count rendered as `<cap>+` per the shared contract.
   All to stderr; stdout stays the event stream. Only the validated numeric `backlogCount` is interpolated
   — no raw server string.

## consequences

- `wbhk listen --resume` picks up exactly where the last run for that (profile, endpoint) left off;
  `--reset` starts fresh; a plain `listen` is unchanged (no new files, no banner unless behind).
- A backlog replay is announced, so a `--forward` user isn't surprised by a flood of re-deliveries.
- Cross-run resume is gap-free and duplicate-free in the common case: persistence tracks what the client
  actually processed, advancing monotonically.

## alternatives considered

- **Persist after the ack (every frame).** Rejected — a no-op ack on a closing socket or a redelivery
  would persist a cursor not-newly-processed / move it backwards. Persisting inside the `!seen` guard ties
  the saved cursor to processed-in-order events.
- **The O_EXCL single-listener lock.** Deferred — it's a client-courtesy footgun guard (the server has no
  single-listener enforcement), not correctness; kept out to keep this slice focused. Named, not dropped.
- **`--no-resume`.** Deferred — absence of `--resume` already means no-resume + no-persist; the explicit
  flag only earns its keep once resume can be defaulted on (e.g. a future profile setting).
- **A blocking backlog prompt.** Rejected for now — prompting from the mid-stream message handler is
  awkward and TTY-coupled; a non-blocking stderr banner informs without stalling the tunnel.

## human verification

The banner copy ("caught up — now tailing live events", "N events behind — replaying the backlog…") is
user-facing stderr output — behavior is tested, but the wording warrants a human eyeball before release
(per the human-UI guardrail).
