"use client";

import type { ConnectedApp } from "@webhook-co/contract";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@webhook-co/ui";
import * as React from "react";

import type { RevokeConnectedAppResult } from "@/server/connected-apps-actions";

import { ScopeSummary } from "./scope-summary";

function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/**
 * The dashboard "Connected apps" manager — a user's authorized OAuth clients (Claude, Cursor, …), each with
 * its proven identity, verified status, granted scopes, and a one-click revoke. Revoking calls auth. (which
 * deletes the provider grant + evicts the token), so the app immediately loses access.
 */
export function ConnectedAppsManager({
  initialApps,
  revoke,
}: {
  initialApps: readonly ConnectedApp[];
  revoke: (grantId: string) => Promise<RevokeConnectedAppResult>;
}) {
  const [apps, setApps] = React.useState<readonly ConnectedApp[]>(initialApps);
  const [target, setTarget] = React.useState<ConnectedApp | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function confirmRevoke() {
    if (!target) return;
    setPending(true);
    setError(null);
    try {
      const result = await revoke(target.grantId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApps((prev) => prev.filter((a) => a.grantId !== target.grantId));
      setTarget(null);
    } catch {
      setError("We couldn't revoke access. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (apps.length === 0) {
    return (
      <p className="text-fg-secondary">
        No apps are connected. When you authorize an app (like Claude or Cursor) to your webhook.co
        account, it&rsquo;ll appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2.5">
        {apps.map((app) => (
          <li
            key={app.grantId}
            className="flex flex-col gap-3 rounded-control border border-hairline p-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-fg">{app.clientName}</span>
                {app.verified ? (
                  <Badge tone="ok" className="text-xs">
                    ✓ verified
                  </Badge>
                ) : (
                  <Badge tone="neutral" className="text-xs">
                    unverified
                  </Badge>
                )}
              </span>
              <span className="break-all font-mono text-sm text-fg-secondary">
                {app.identityDomain ?? "no verified domain"}
              </span>
              {/* div, not span: ScopeSummary renders a <details> (flow content), which is invalid inside a
                  phrasing-only <span>. */}
              <div className="pt-0.5">
                <ScopeSummary scopes={app.scopes} />
              </div>
              <span className="pt-0.5 text-xs text-fg-faint">
                {/* Which org this app can see (token = org). "unknown organization" for a legacy grant
                    authorized before the org was recorded, or one whose org couldn't be resolved. */}
                Organization:{" "}
                {app.org ? `${app.org.name} (${app.org.slug})` : "unknown organization"} · Connected{" "}
                {fmtDate(app.createdAt)}
              </span>
            </div>
            <Button variant="secondary" onClick={() => setTarget(app)} className="shrink-0">
              Revoke
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke access?</DialogTitle>
            <DialogDescription>
              {target ? (
                <>
                  <span className="font-medium">{target.clientName}</span> will immediately lose
                  access to your webhook.co account. It can reconnect later by asking for
                  authorization again.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {/* Render the error INSIDE the dialog — a Banner in the page body would sit behind the overlay
              and the user wouldn't see why the revoke failed while the dialog is still open. */}
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={confirmRevoke} disabled={pending}>
              {pending ? "Revoking…" : "Revoke access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
