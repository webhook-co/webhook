"use client";

import { Banner, Button } from "@webhook-co/ui";
import { useState } from "react";

import type { LoginMethod, UnlinkLoginMethodResult } from "@webhook-co/contract";

const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub" };
const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id;
const methodKey = (m: LoginMethod) => `${m.providerId}:${m.accountId}`;

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
 * The social sign-ins linked to the account (Google / GitHub), each with a Disconnect. Connecting a NEW
 * provider isn't a button here — signing in with a provider whose email matches your account links it
 * automatically (Better Auth's pinned verified-email linking) — so we say so rather than run a fragile
 * cross-domain OAuth-link flow. The server enforces a last-method guard (you can always still sign in with a
 * magic link, so removing a social login never strands you).
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
      {methods.length === 0 ? (
        <p className="text-sm text-fg-secondary">
          No social logins are linked. You sign in with a magic link to your email.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {methods.map((m) => (
            <li
              key={methodKey(m)}
              className="flex items-center justify-between gap-4 rounded-control border border-hairline p-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-fg">{providerLabel(m.providerId)}</span>
                {fmtDate(m.linkedAt) ? (
                  <span className="text-xs text-fg-faint">Linked {fmtDate(m.linkedAt)}</span>
                ) : null}
              </span>
              <Button
                variant="secondary"
                onClick={() => onDisconnect(m)}
                loading={pendingKey === methodKey(m)}
                disabled={pendingKey !== null}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <p className="text-xs text-fg-faint">
        To add Google or GitHub, sign out and sign back in with that provider using this email —
        we&apos;ll link it to your account automatically.
        {hasMagicLink ? " You can always sign in with a magic link to your email." : null}
      </p>
    </div>
  );
}
