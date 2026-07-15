/** A scope's display copy: the exact `resource:verb` machine scope + a plain-English title and one-line
 *  description. Produced by the caller's `describe` (e.g. `describeScope` from `@webhook-co/contract`). */
export interface ScopeDescription {
  scope: string;
  title: string;
  description: string;
}

/**
 * A compact, expandable summary of a set of granted (or about-to-be-granted) scopes.
 *
 * The face is a count ("3 permissions", plus an optional `labelSuffix`); expanding reveals a plain-English
 * title + one-line description per scope, each still showing the exact `resource:verb` machine scope for
 * auditability. Native `<details>` on purpose: no client JS, works inside server components,
 * keyboard-accessible, and — crucially — the full body is in the DOM for assistive tech EVEN while collapsed
 * (a screen-reader user reaches every permission; only the sighted default view is condensed).
 *
 * Presentational only: the caller injects `describe` (e.g. `describeScope` from `@webhook-co/contract`), so
 * this package carries no contract dependency and both the dashboard review surfaces and the consent screen
 * share one component. On the consent screen this is collapsed-by-default at the founder's explicit request
 * (ADR-0120); it passes a `labelSuffix` (" — review before authorizing") that keeps the grant honest.
 */
export function ScopeSummary({
  scopes,
  describe,
  labelSuffix,
}: {
  scopes: readonly string[];
  describe: (scope: string) => ScopeDescription;
  /** Appended to the "N permission(s)" count (the component owns the pluralization) — e.g. the consent
   *  screen passes " — review before authorizing". */
  labelSuffix?: string;
}) {
  if (scopes.length === 0) {
    return <span className="text-xs text-fg-faint">No permissions</span>;
  }

  const infos = scopes.map(describe);
  const face = `${scopes.length} permission${scopes.length === 1 ? "" : "s"}${labelSuffix ?? ""}`;

  return (
    <details className="group max-w-md">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-fg-secondary hover:text-fg [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-fg-faint transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          ›
        </span>
        {face}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 pl-4">
        {infos.map((info) => (
          <li key={info.scope} className="text-sm leading-snug">
            <span className="font-medium text-fg">{info.title}</span>
            {/* Keep the exact machine scope visible for auditability — but not when it IS the title (an
                unknown scope's fallback), where it would just repeat. */}
            {info.title !== info.scope ? (
              <span className="ml-1.5 font-mono text-xs text-fg-faint">{info.scope}</span>
            ) : null}
            <span className="text-fg-faint"> — {info.description}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
