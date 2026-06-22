# ADR 0042 — CLI cross-run resume: the cursor state store

- status: accepted (**D6a** — the persistence module; the `listen` integration + `--resume`/`--reset`
  flags + the lag banner/backlog guard + the single-listener lock land in **D6b**).
- date: 2026-06-22
- scope: `packages/cli/src/state/cursor-store.ts` (new) + `state/cursor-store.test.ts` (new). Reads the
  XDG state dir via `resolveStateDir` (shipped in D5/ADR-0041). No `listen.ts` change yet.
- relates: ADR-0041 (the XDG state/cache resolvers this consumes), ADR-0014 (the listen tunnel whose
  durable cursor this persists), ADR-0009 (the file-store secure-write pattern this mirrors).
  `internal/build-plans/lane-d-cli.md` §D6. Lane D (`packages/cli`).
- review severity: medium (durable on-disk state + a path-traversal surface). One combined code+security
  review (SHIP) — the one MINOR (re-tighten a pre-existing `listen/` dir) was folded.

## context

`wbhk listen` resumes within a single run (it reuses the sessionId across reconnects, and the engine
resumes from the durable cursor). But across SEPARATE runs there was no memory: `Ctrl-C`, then re-run, and
you either re-replayed the whole backlog or missed the gap. D6 adds cross-run resume; this slice (D6a) is
the storage half — a small, self-contained, fully-tested module — kept separate from the `listen.ts`
integration (D6b) so each is a reviewable PR.

## decision

1. **A per-(profile, endpoint) cursor file in the XDG STATE dir.** `<stateDir>/listen/<enc(profile)>__<enc(endpointId)>.json`, holding `{ version, endpointId, cursor }`. The
   state dir (not config, not cache) is the right home: durable, machine-local, regenerable-but-not-a-cache.
   The stored value is the OPAQUE event cursor — **never the sessionId** (a sessionId is a connection
   handle, not a resume point; D6b persists `frame.cursor` on ack).

2. **Traversal-safe filenames.** Both `profile` and `endpointId` are `encodeURIComponent`-encoded, so a
   hostile name (`/`, `..`) becomes a single inert filename segment under `listen/` — it cannot escape the
   dir. (The literal `..` chars that survive are harmless without a separator.)

3. **Corruption-tolerant reads → cold-start, never a crash.** `loadCursor` returns a typed
   `hit | miss | corrupt` union: `miss` on ENOENT, `corrupt` (with a reason) on unreadable JSON, a
   schema/version mismatch (`version` is `z.literal`-pinned, so a future-version file is `corrupt`), or a
   stored endpointId that doesn't match. Genuinely-unexpected fs errors rethrow. The caller cold-starts on
   miss/corrupt — a damaged state file degrades to "tail from now", it never breaks the command.

4. **Atomic writes.** `saveCursor` writes a uuid-suffixed temp file in the SAME dir, fsyncs it, then
   renames over the target — a crash mid-write leaves either the old cursor or the new one, never a
   partial. Dir `0700` (re-tightened on every write, like file-store), file `0600`. `clearCursor`
   (the `--reset` path) unlinks, ENOENT-tolerant.

## consequences

- D6b can load a persisted cursor on `--resume`/`--since from-last-ack` (→ `?sinceCursor=`) and persist
  on each ack, giving gap-free cross-run resume.
- A corrupt or stale state file is self-healing (cold-start), so the resume feature can never wedge a tail.
- The cursor is non-secret + opaque, but the file is `0600` and the dir `0700` for tidiness + consistency.

## alternatives considered

- **A single cursors.json keyed by profile+endpoint.** Rejected — a per-pair file makes the future
  per-pair `O_EXCL` single-listener lock (D6b) natural and avoids read-modify-write contention between
  concurrent `listen`s on different endpoints.
- **A migration ladder (like config v2).** Rejected — the cursor is a regenerable resume hint, not user
  data; a version bump should cold-start (`corrupt`), not migrate.
- **Inject an fs seam for testing.** Rejected — the established pattern (file-store.ts) tests fs logic
  against a real tmpdir, which also exercises the real atomic-rename + fsync path; an in-memory fake would
  test less.
- **Store the sessionId as the resume point.** Rejected — a sessionId is a connection handle; the opaque
  event cursor is the durable resume position.
