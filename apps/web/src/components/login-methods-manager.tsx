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
       * The opaque provider account id, present ONLY when this provider has more than one linked account.
       * `null` on the common path, where it would just be noise.
       *
       * It is not much: the user cannot map "g-1" to an inbox, so it proves the rows are DIFFERENT without
       * saying which is which. The genuinely useful discriminator — the provider account's email — is not on
       * `LoginMethod` and putting it there is a contract change plus a new read (its own slice). Until then
       * this row also widens its timestamp to the minute, which is what a human can actually act on; the id
       * stays because two same-minute links would otherwise still collide, and it keeps the accessible name
       * unique.
       */
      readonly discriminator: string | null;
    }
  | { readonly kind: "empty"; readonly key: string; readonly label: string };

/**
 * One slot per offered provider, in OFFERED order, holding either its linked account(s) or a "not connected"
 * placeholder — then any linked provider we don't offer.
 *
 * What this guarantees, exactly: providers never REORDER relative to each other. Appending the placeholders
 * last made a provider's rank depend on its link state, so disconnecting Google re-rendered the list as
 * GitHub, Google — Google leapfrogged a provider it had been above, and the Disconnect that landed under the
 * cursor belonged to an account the user never touched.
 *
 * What it does NOT guarantee: that no row ever moves. A provider holding two accounts occupies two rows, so
 * removing one of them still shifts everything below it up by a row — unavoidable when a list gets shorter,
 * and not the same defect as a reorder. Do not restate this as "rows never move"; that claim is false and was
 * written here once already.
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
  // Oldest first, accountId as the tiebreak: a stable order that never depends on the server's row order.
  const linkedFor = (id: string): Row[] => {
    const mine = methods
      .filter((m) => m.providerId === id)
      .sort((a, b) => a.linkedAt - b.linkedAt || a.accountId.localeCompare(b.accountId));
    return mine.map((m) => ({
      kind: "linked" as const,
      key: methodKey(m),
      label: providerLabel(m.providerId),
      method: m,
      discriminator: mine.length > 1 ? m.accountId : null,
    }));
  };

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

/**
 * Date + time (UTC), for a row that has a same-provider sibling. Two accounts of one provider are commonly
 * linked on the same DAY — the exact case the date alone renders byte-identical — so the minute is the first
 * thing a human can actually use to tell "the one I added just now" from "the old one".
 */
function fmtDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The row's secondary line. A lone account gets the date; one with a same-provider sibling gets the minute
 * and its account id, because that pair is what has to be told apart. See Row.discriminator.
 */
function connectedLine(linkedAt: number, discriminator: string | null): string {
  const when = discriminator ? fmtDateTime(linkedAt) : fmtDate(linkedAt);
  return [when ? `Connected ${when}` : "Connected", discriminator].filter(Boolean).join(" · ");
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
 * WHY "CONNECT" IS NOT A BUTTON. Not because linking is unavailable — an earlier version of this comment
 * claimed "there is no link route on auth.webhook.co" and that was simply false. `POST /api/auth/link-social`
 * has always been mounted: the `[...all]` catch-all hands the raw Request to Better Auth with no allowlist,
 * and the captcha plugin gates only `/sign-in/magic-link`.
 *
 * What is missing is a PAGE on the auth origin that calls it, and the dashboard cannot call it from here: the
 * auth session cookie is host-only (founder decision X-2 — no cross-subdomain sharing), so a credentialed
 * cross-origin fetch would need CORS that apps/auth deliberately does not configure. It would also buy
 * nothing — /link-social returns the provider's authorize URL, which the browser has to navigate to anyway.
 * (`/login` can't be borrowed as that page: it bounces an already-signed-in user to /session/handoff.)
 *
 * So signing in with the provider IS the way to link, and that is deliberate rather than a stopgap: Better
 * Auth's implicit linking is SAME-EMAIL only and the founder wants it that way. `findOAuthUser` locates the
 * user BY EMAIL, so a match is structural; the account row is then inserted as long as the provider asserts a
 * verified email (required — `trustedProviders` is empty) and the local account is verified (it always is:
 * magic-link sets emailVerified on create and sign-in, and our email-change writes it true).
 *
 * Hence the copy below says "using this email" — that is the actual constraint, not a hedge, and same-email is
 * now the policy on EVERY path: ADR-0121 turned `allowDifferentEmails` off, so even the explicit /link-social
 * route refuses a provider whose email doesn't match.
 *
 * A provider whose email DIFFERS therefore does not link and does not error — it creates a separate account.
 * That is a known trap, it is pre-existing, and it is tracked on its own; a Connect button would NOT fix it
 * without reopening ADR-0121 first. See internal/build-plans/connect-social-login-slice.md.
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
                  connectedLine(row.method.linkedAt, row.discriminator)
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
