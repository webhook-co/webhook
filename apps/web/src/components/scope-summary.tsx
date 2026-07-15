import { describeScope } from "@webhook-co/contract/scope-catalog";

/**
 * A compact, expandable summary of a credential's granted scopes.
 *
 * The review surfaces (connected apps, API keys, devices) previously rendered every scope as an uncapped row
 * of `resource:verb` mono chips — noisy, and meaningless to anyone who doesn't already know the scope grammar.
 * Here the face is just a count ("3 permissions"); expanding reveals a plain-English title + description per
 * scope from the shared catalog.
 *
 * Native `<details>` on purpose: no client JS, works inside server components, keyboard-accessible, and the
 * body is in the DOM for assistive tech even while collapsed. This is a REVIEW surface (access is already
 * granted), so collapse-by-default is a convenience, not the consent-screen dark pattern of hiding
 * about-to-be-granted permissions behind a click.
 */
export function ScopeSummary({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) {
    return <span className="text-xs text-fg-faint">No permissions</span>;
  }

  const infos = scopes.map(describeScope);
  const label = `${scopes.length} permission${scopes.length === 1 ? "" : "s"}`;

  return (
    <details className="group max-w-md">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-fg-secondary hover:text-fg [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-fg-faint transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {label}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 pl-4">
        {infos.map((info) => (
          <li key={info.scope} className="text-sm leading-snug">
            <span className="font-medium text-fg">{info.title}</span>
            {/* Keep the exact machine scope visible for auditability (matching the consent screen) — but not
                when it IS the title (an unknown scope's fallback), where it would just repeat. */}
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
