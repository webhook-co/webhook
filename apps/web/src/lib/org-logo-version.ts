/**
 * A module-global "an org logo changed" counter, shared by every {@link OrgAvatar} on the page — the org
 * mirror of `avatar-version.ts`.
 *
 * `/api/org-logo/{slug}` is per-org (input-ful) but still browser-cached (`max-age=60`), so after an upload
 * `router.refresh()` alone won't refetch an `<img>` whose URL is unchanged. Every `OrgAvatar` subscribes to
 * this counter via `useSyncExternalStore`; one `orgLogoVersion.bump()` after a successful upload re-renders
 * them all with a fresh `?v=`, so they refetch at once (including the switcher trigger + list rows).
 *
 * It only moves forward, within a client session; a full reload starts at 0 and the server render is the
 * canonical un-versioned URL again (by then the upload has persisted, so the plain URL is right).
 */
let version = 0;
const listeners = new Set<() => void>();

export const orgLogoVersion = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): number {
    return version;
  },
  /** Server snapshot: always 0, so SSR emits the canonical `/api/org-logo/{slug}` (no `?v=`). */
  getServer(): number {
    return 0;
  },
  /** Signal that an org logo just changed — every subscribed OrgAvatar refetches. */
  bump(): void {
    version += 1;
    for (const listener of listeners) listener();
  },
  /** Test-only: reset the module-global counter so a bump in one test can't leak into the next. */
  __resetForTests(): void {
    version = 0;
  },
};
