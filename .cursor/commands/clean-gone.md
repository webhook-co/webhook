# /clean-gone

Prune local branches whose remote tracking branch has been deleted (typically after their PR merged).

## How to run

1. Update remote state and prune stale remote-tracking refs: `git fetch --prune`.
2. Find local branches marked `[gone]`: `git branch -vv` and select the ones whose upstream shows
   `: gone]`.
3. Show me the candidate list **before deleting anything.** Never delete the current branch or the
   default branch (`main`/`master`).
4. Delete the confirmed branches with `git branch -d` (safe delete — only fully-merged branches). If
   one isn't merged, `-d` will refuse: **report it and let me decide**; do not silently `-D`
   (force-delete) a branch that may carry unmerged work.

## Hard rules

- Local-only operation: never touch the remote, never delete remote branches, never force-push.
- Don't `-D` force-delete unless I explicitly confirm that branch — losing unmerged commits is not an
  acceptable way to "clean up."
- Leave `main`/`master` and the current branch alone.
