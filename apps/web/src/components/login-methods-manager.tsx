"use client";

import { Banner, Button } from "@webhook-co/ui";
import { useState } from "react";

import type { LoginMethod, UnlinkLoginMethodResult } from "@webhook-co/contract";

/**
 * The providers we OFFER, in display order. Used to add "not connected" placeholder rows — NEVER to decide
 * what gets rendered: see `rows()`. A linked account that isn't in this list must still appear, or it becomes
 * an invisible way into the account.
 */
const OFFERED = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
] as const;

// Derived from OFFERED, never a second hand-maintained copy: adding a provider to one list and forgetting the
// other would render the same provider as "GitLab" on an unlinked row and raw "gitlab" on a linked one.
const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  OFFERED.map((p) => [p.id, p.label]),
);
const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;
const methodKey = (m: LoginMethod) => `${m.providerId}:${m.accountId}`;

type Row =
  | {
      readonly kind: "linked";
      readonly key: string;
      readonly label: string;
      readonly method: LoginMethod;
      /**
       * The opaque provider account id, but ONLY when this provider has more than one linked account — the
       * sole thing that tells two otherwise byte-identical rows apart. `null` on the common path, where it
       * would just be noise.
       */
      readonly discriminator: string | null;
    }
  | { readonly kind: "empty"; readonly key: string; readonly label: string };

/**
 * One FIXED slot per offered provider, in OFFERED order, holding either its linked account(s) or a "not
 * connected" placeholder — then any linked provider we don't offer.
 *
 * Slots must not depend on link state. Appending the placeholders last meant disconnecting Google re-rendered
 * the list as GitHub, Google: the row you just clicked jumps position, and the Disconnect now under your
 * cursor belongs to the account you did NOT touch — one stray click from removing the wrong way in.
 *
 * Emphatically not "one row per offered provider, find the matching method". `listLoginMethods` returns every
 * `account` row for the user with NO provider filter, and nothing stops a user having two of the same
 * provider — link google:a@x, change email to b@y, sign in with a second Google whose verified email is b@y,
 * and the pinned auto-link writes a second google row. (The (providerId, accountId) unique index doesn't
 * prevent that; it only stops the SAME account linking twice.) A `find` would render the newest and silently
 * drop the older — leaving a fully working sign-in path with no control able to remove it, on the one page
 * whose job is to enumerate exactly those. Same for any provider added to the issuer later: it would stay
 * invisible until someone remembered to edit the array above.
 */
function rows(methods: readonly LoginMethod[]): Row[] {
  const count = (id: string) => methods.filter((m) => m.providerId === id).length;
  // Oldest first, accountId as the tiebreak: a stable order that never depends on the server's row order.
  const linkedFor = (id: string): Row[] =>
    methods
      .filter((m) => m.providerId === id)
      .slice()
      .sort((a, b) => a.linkedAt - b.linkedAt || a.accountId.localeCompare(b.accountId))
      .map((m) => ({
        kind: "linked" as const,
        key: methodKey(m),
        label: providerLabel(m.providerId),
        method: m,
        discriminator: count(m.providerId) > 1 ? m.accountId : null,
      }));

  const out: Row[] = [];
  for (const p of OFFERED) {
    const linked = linkedFor(p.id);
    out.push(
      ...(linked.length
        ? linked
        : [{ kind: "empty" as const, key: `empty:${p.id}`, label: p.label }]),
    );
  }
  const offered = new Set<string>(OFFERED.map((p) => p.id));
  const extras = [...new Set(methods.map((m) => m.providerId))]
    .filter((id) => !offered.has(id))
    .sort();
  for (const id of extras) out.push(...linkedFor(id));
  return out;
}

function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export interface LoginMethodsManagerProps {
  readonly initialMethods: readonly LoginMethod[];
  readonly hasMagicLink: boolean;
  readonly disconnect: (providerId: string, accountId: string) => Promise<UnlinkLoginMethodResult>;
}

/**
 * The social sign-ins linked to the account. BOTH providers always render — connected ones with a red
 * Disconnect, unconnected ones saying how to connect.
 *
 * WHY "CONNECT" IS NOT A BUTTON YET. Linking a new provider needs Better Auth's `linkSocial`, which must run
 * on the auth origin against a live IdP session — the dashboard is app.webhook.co and there is no link route
 * on auth.webhook.co (and `/login` bounces an already-signed-in user straight to /session/handoff, so it
 * can't be borrowed for this). Until that route exists, signing in with the provider is genuinely the way to
 * link it: the pinned verified-email auto-link does the work. A button that only said "Connect" and then
 * explained you have to sign out would be worse than the sentence.
 *
 * The server enforces a last-method guard, so disconnecting can never strand you.
 */
export function LoginMethodsManager({
  initialMethods,
  hasMagicLink,
  disconnect,
}: LoginMethodsManagerProps) {
  const [methods, setMethods] = useState<readonly LoginMethod[]>(initialMethods);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDisconnect(m: LoginMethod) {
    setPendingKey(methodKey(m));
    setError(null);
    const res = await disconnect(m.providerId, m.accountId);
    setPendingKey(null);
    if (res.ok) setMethods((prev) => prev.filter((x) => methodKey(x) !== methodKey(m)));
    else setError(res.error);
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {rows(methods).map((row) => (
          <li
            key={row.key}
            className="flex items-center justify-between gap-4 rounded-control border border-hairline p-3"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-fg">{row.label}</span>
              <span className="text-xs text-fg-faint">
                {row.kind === "linked" ? (
                  [
                    fmtDate(row.method.linkedAt)
                      ? `Connected ${fmtDate(row.method.linkedAt)}`
                      : "Connected",
                    // Only present when this provider has a second account — see Row.discriminator.
                    row.discriminator,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                ) : (
                  // "Sign out and" is load-bearing, not filler: /login bounces an already-signed-in user
                  // straight to /session/handoff, so "sign in with GitHub" attempted from THIS page silently
                  // returns you to the dashboard and reads as broken. Dropping those two words turned a
                  // followable procedure into a dead end.
                  <>
                    Not connected — sign out and sign back in with {row.label} using this email to
                    link it
                  </>
                )}
              </span>
            </span>
            {row.kind === "linked" ? (
              <Button
                variant="danger"
                onClick={() => onDisconnect(row.method)}
                loading={pendingKey === row.key}
                disabled={pendingKey !== null}
                // A bare "Disconnect" is announced identically for two Google rows, so a screen-reader user
                // cannot tell which sign-in path they're about to remove. Name the account whenever there's
                // more than one to choose between.
                aria-label={
                  row.discriminator
                    ? `Disconnect ${row.label} (${row.discriminator})`
                    : `Disconnect ${row.label}`
                }
              >
                Disconnect
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {hasMagicLink ? (
        <p className="text-xs text-fg-faint">
          You can always sign in with a magic link to your email.
        </p>
      ) : null}
    </div>
  );
}
