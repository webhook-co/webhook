// The CLI version, single-sourced (app.ts re-exports it for `--version`; doctor reads it). It's STAMPED at
// build time: the release bundle injects the real version via `bun build --define WBHK_VERSION='"x.y.z"'`
// (driven from the `cli-vX.Y.Z` release tag — see internal/build-plans/cli-distribution.md, DIST-1). A plain
// `tsc`/`node`/test run (no --define) leaves it the placeholder "0.0.0", which `doctor` surfaces as a
// `(dev)` build. `resolveVersion` is the pure, testable core; the `typeof` guard keeps an un-stamped build
// from a ReferenceError on the undeclared identifier.

declare const WBHK_VERSION: string | undefined;

/** The stamped version, or "0.0.0" when un-stamped (undefined / empty) — a dev build. */
export function resolveVersion(stamped: string | undefined): string {
  return stamped !== undefined && stamped.length > 0 ? stamped : "0.0.0";
}

export const VERSION = resolveVersion(typeof WBHK_VERSION === "string" ? WBHK_VERSION : undefined);
