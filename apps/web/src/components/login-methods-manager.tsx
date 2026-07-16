"use client";

import { Banner, Button } from "@webhook-co/ui";
import { useState } from "react";

import type { LoginMethod, UnlinkLoginMethodResult } from "@webhook-co/contract";

/**
 * Every provider this account CAN use, in display order — not just the linked ones. The rows are persistent
 * so the surface answers "how can I sign in?" at a glance: an unlinked provider is a real, visible state
 * ("not connected"), not an absence you have to infer from a list that isn't there.
 */
const PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
] as const;

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
        {PROVIDERS.map((p) => {
          const linked = methods.find((m) => m.providerId === p.id);
          return (
            <li
              key={p.id}
              className="flex items-center justify-between gap-4 rounded-control border border-hairline p-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-fg">{p.label}</span>
                <span className="text-xs text-fg-faint">
                  {linked
                    ? fmtDate(linked.linkedAt)
                      ? `Connected ${fmtDate(linked.linkedAt)}`
                      : "Connected"
                    : `Not connected — sign in with ${p.label} using this email to link it`}
                </span>
              </span>
              {linked ? (
                <Button
                  variant="danger"
                  onClick={() => onDisconnect(linked)}
                  loading={pendingKey === methodKey(linked)}
                  disabled={pendingKey !== null}
                >
                  Disconnect
                </Button>
              ) : null}
            </li>
          );
        })}
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
