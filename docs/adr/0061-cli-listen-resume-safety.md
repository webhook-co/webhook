# ADR 0061 — `wbhk listen` resume safety: `--max-backlog` + single-listener lock

- status: accepted (close-out audit follow-ups FID-D-06 + FID-D-07, founder-approved 2026-06-24).
- date: 2026-06-24
- scope: `commands/listen.ts` (`--max-backlog` flag + status-frame refusal + `stop(reason)` → exit
  mapping); new `state/listen-lock.ts` (O_EXCL single-listener lock) + tests; two new exit codes
  (`BACKLOG_EXCEEDED` 17, `LISTENER_BUSY` 18) in `output/exit-codes.ts`.
- relates: ADR-0043 (cross-run resume — these are the two safety controls it deferred); ADR-0060 (the
  bounded `--forward` retry, whose `stop` dep this generalizes). `~/.claude/plans/cozy-greeting-cupcake.md`
  Lane D close-out.
- review severity: medium (changes when the tail refuses/stops + adds a client-side lock). `/code-review`
  + `/security-review`.

## context

The Lane-D close-out audit flagged two deferred resume-safety gaps:

- **FID-D-06:** the backlog guard ships as an informational stderr banner ("N events behind — replaying the
  backlog…"), not the planned flood-refusal. With `--forward`, opening a tail against a large retained
  backlog fires the whole backlog at the local server (the "side-effect cannon").
- **FID-D-07:** two concurrent resuming listeners on the same `(profile, endpoint)` race the cursor file.
  Atomic writes prevent corruption, but last-finisher wins → a re-delivery window. The server has no
  single-listener enforcement.

The founder chose to **build both** (rather than keep them deferred).

## decision

1. **`--max-backlog <N>` — opt-in flood-refusal.** When set and a status frame reports a backlog ≥ N (and
   we're not caught up), stop the tail with a loud stderr error ("refusing to replay: N events behind
   exceeds --max-backlog M — stopping (raise --max-backlog, or use --since now to skip the backlog)") and
   exit `BACKLOG_EXCEEDED` (17). Off by default (the informational banner is unchanged). N=0 means "refuse
   ANY backlog" (only tail when caught up). **Best-effort:** the refusal fires on the first status frame
   over the cap, so a few events may arrive before it — it bounds the cannon, it doesn't guarantee zero
   pre-refusal delivery (the CLI can't know the backlog size before connecting). Raising the cap or
   `--since now` skips the backlog entirely.

2. **Single-listener lock (`--resume` only).** `state/listen-lock.ts` acquires an `O_EXCL` lockfile per
   `(profile, endpoint)` — same XDG state layout + traversal-safe naming as the cursor (ADR-0043) — before
   the tail, releasing it in `finally`. A live holder → `ListenLockedError` (a CliError → printed on-voice,
   exit `LISTENER_BUSY` 18). A lock left by a crashed run is **reclaimed**: on `EEXIST` we read the holder
   pid and, if `process.kill(pid, 0)` shows it dead (ESRCH) or the lock is unreadable, unlink + retry once.
   The lock is gated on `--resume` because that's the only mode that writes the cursor file (the race);
   plain tails don't persist, so they're unaffected. It's a **client-side courtesy** (zero deps, handles
   the realistic footgun of one human double-running the command), not server-enforced correctness.

3. **`stop(reason)` + distinct exit codes.** ADR-0060's `stop()` dep is generalized to `stop(reason)` where
   reason ∈ {`forward-permanent-failure`, `backlog-exceeded`}; the command maps each to a distinct,
   scriptable exit (`TARGET_UNREACHABLE` 16 / `BACKLOG_EXCEEDED` 17) — never confused with a clean Ctrl-C
   (exit 0). A dup-ADR-style value-lock test pins the two new codes.

A new CI lint already prevents the ADR-number collisions this file could have re-introduced (ADR-0057/the
`adr-no-dup` guard).

## consequences

- `wbhk listen <ep> --forward <local> --max-backlog 500` refuses (and exits 17) rather than firing a
  >500-event backlog at the local server; default behavior is unchanged (banner only).
- A second `wbhk listen --resume` on the same profile+endpoint is refused with a clear message (exit 18)
  instead of silently racing the cursor file; a crashed prior run's stale lock self-heals on the next run.
- Two new public exit codes (17/18) — additive to the documented contract; the value-lock test makes a
  change deliberate.
- No new dependency; the lock reuses the cursor's state layout, and `--max-backlog` rides the existing
  status-frame signal.

## alternatives considered

- **A blocking interactive prompt for a large backlog.** Rejected (ADR-0043 already rejected it) — a flag
  is scriptable + non-interactive-friendly; a prompt breaks piped/CI use.
- **`proper-lockfile` / a networked-FS lock.** Rejected for v1 — the realistic contention is one local box;
  `O_EXCL` + pid-staleness is zero-dep and survives `bun --compile`. Reserve a networked lock for a real
  networked-home user.
- **Lock all listens, not just `--resume`.** Rejected — two plain tails don't race (no cursor file; the
  server dedups acks); locking them would be a gratuitous restriction.
- **Reuse a generic non-zero exit for both refusals.** Rejected — distinct codes let a script branch on
  "backlog too large" vs "another listener running" vs a real failure (the CLI treats exit codes as API).
