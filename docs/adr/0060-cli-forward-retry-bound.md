# ADR 0060 — bound the `listen --forward` per-event retry (no head-of-line wedge)

- status: accepted (close-out audit fix, MEDIUM — a permanently-failing `--forward` target no longer wedges
  the tail).
- date: 2026-06-23
- scope: `commands/listen.ts` (`forwardWithRetry` attempt cap + a `stop` dep on `RunListenDeps`; the command
  flags a non-zero exit) + a permanent-failure test.
- relates: the cursor-gated `--forward` delivery (where the wedge lived); `~/.claude/plans/cozy-greeting-cupcake.md`
  Lane D close-out. ADR-0043 (resume — the `--resume` retry path this leans on).
- review severity: medium (changes forward error-handling + cursor-advancement on permanent failure).
  `/code-review` + `/security-review`.

## context

`wbhk listen --forward <localhost>` re-delivers each tailed event to a local server on a SERIAL,
cursor-gated chain: an event is acked (advancing the durable cursor) only after a local 2xx, and the next
event's link can't start until the current one finishes. `forwardWithRetry` looped with capped backoff and
its ONLY non-abort exit was a local 2xx. So a target that PERMANENTLY returns non-2xx (always-500, connection
refused) retried forever: every later event blocked behind it, the durable cursor never advanced, and only
Ctrl-C escaped — with just a repeating "…— retrying" stderr note. A broken local server silently wedged the
whole tail.

## decision

1. **Cap the per-event forward at `FORWARD_MAX_ATTEMPTS` (8).** High enough that a transient blip recovers via
   the existing capped-exponential backoff, low enough that a permanent failure is caught in ~a minute rather
   than never. The cap covers both the `fetchPayload` and the `post` failure paths (they share the loop).

2. **On exhaustion: stop the tail cleanly, loudly, and named — don't skip silently.** A distinct stderr error
   (not the per-attempt "retrying") names the stuck event id + the attempt count + the target + the remedy:
   `giving up on <id> → <target> after 8 attempts — stopping the tail (fix the target, then re-run with
   --resume to retry from here)`. The event is left **UN-ACKED**, so it isn't lost: a `--resume` re-run picks
   up from it once the target is fixed. The command exits non-zero (`TARGET_UNREACHABLE`, 16) — distinct from
   a clean Ctrl-C (0) — so a script/CI run notices the deliveries didn't go through.

3. **Mechanism: a `stop()` dep on `RunListenDeps`.** `forwardWithRetry` calls `deps.stop()` on exhaustion;
   the command wires it to flag the non-zero exit + abort the controller (which the reconnect loop already
   watches → it closes the socket + returns). Under test, `stop` aborts the signal. `stop` is only ever called
   from the forward attempt-cap, so its presence ⇒ a permanent forward failure.

**Stop vs skip.** The audit allowed either "stop cleanly" or "skip-without-ack (redelivers next run)". We
chose STOP because it's deterministic and avoids the skip path's ambiguity: with monotonic cursor persistence,
a later acked event would advance the saved `--resume` cursor PAST a skipped one (silently dropping it), and
in-session a high-water-mark ack could do the same. Stopping leaves exactly one un-acked event at a known
position — clean to resume, nothing dropped. A permanently-failing target is a "fix your server" condition,
not a "quietly drop events" one.

## consequences

- A broken `--forward` target now ends the tail in ~a minute with a clear, actionable error + a non-zero exit,
  instead of wedging forever. `wbhk listen --forward … --resume` after fixing the target retries from the
  stuck event.
- A transient blip (a few non-2xx then recovery) still rides through within the 8-attempt budget — unchanged
  behavior for the common case.
- Inspection mode (no `--forward`) and the TUI (inspection + on-demand `r`) never call `stop` — unaffected.
- The `record`-failure path (forward succeeded, server-side `events.replay` record threw) is unchanged: it
  returns un-acked and redelivers on reconnect (throttled by reconnect backoff, not a tight in-session loop),
  so it isn't a wedge and is out of scope here.

## alternatives considered

- **Skip-without-ack + continue.** Rejected — see "Stop vs skip"; risks silently dropping the skipped event.
- **A wall-clock budget instead of an attempt cap.** Equivalent; the attempt cap is simpler + deterministic to
  test (an exact post count) and already rides the capped backoff for wall-clock bounding.
- **Leave it (rely on Ctrl-C).** Rejected — the audit MEDIUM: a silent wedge with only a repeating note is a
  real footgun for an unattended `--forward` run.
