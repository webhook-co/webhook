/**
 * A tiny module-global "the avatar changed" counter, shared by every {@link UserAvatar} on the page.
 *
 * Why it exists: `/api/avatar` takes no input (it reads the session), so its URL is identical everywhere and
 * the browser caches it. After an upload, `router.refresh()` re-renders the server components but does NOT
 * refetch an `<img>` whose URL hasn't changed — so the nav avatar, the greeting, and any other instance would
 * keep showing the stale (or initials-fallback) image for up to the cache TTL. A per-instance `?v=` prop only
 * fixes the one avatar that owns the state.
 *
 * Instead, every `UserAvatar` subscribes to THIS counter via `useSyncExternalStore`. One `bumpAvatarVersion()`
 * after a successful upload re-renders all of them with a fresh `?v=`, so they all refetch at once — including
 * a user who just added their first-ever photo (whose nav avatar was showing initials).
 *
 * It only moves forward, and only within a client session; a full reload starts back at 0 and the server
 * render is the canonical un-versioned URL again (by then the upload has persisted, so the plain URL is right).
 */
let version = 0;
const listeners = new Set<() => void>();

export function subscribeAvatarVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current version — the `getSnapshot` for `useSyncExternalStore`. */
export function getAvatarVersion(): number {
  return version;
}

/** Server snapshot: always 0, so SSR emits the canonical `/api/avatar` (no `?v=`). */
export function getServerAvatarVersion(): number {
  return 0;
}

/** Signal that the signed-in user's avatar just changed — every subscribed avatar refetches. */
export function bumpAvatarVersion(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Test-only: return the module-global counter to 0 so a bump in one test can't leak into the next. */
export function __resetAvatarVersionForTests(): void {
  version = 0;
}
