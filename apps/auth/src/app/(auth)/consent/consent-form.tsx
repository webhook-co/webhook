"use client";

import { Badge, Banner, Button } from "@webhook-co/ui";
import * as React from "react";

/**
 * The consent grant-summary payload Lane C's `/authorize` handler SSRs into this page — the C→E
 * consent contract (mirrors the recorded {@link https://… ConsentProps} the issuer stashes on
 * approve). E4 renders a {@link mockConsentRequest} fixture so the screen is buildable + reviewable
 * before Lane C's `/authorize` exists; E8 reads the real SSR'd payload, unchanged here.
 */
export interface ConsentRequest {
  /** Opaque id of this pending authorization; echoed back with the decision. */
  readonly requestId: string;
  /** Single-use anti-CSRF token bound to this request + the auth session; echoed with the decision. */
  readonly csrfToken: string;
  /** Which flow asked for consent. Loopback PKCE still shows this screen (deliberate-grant model). */
  readonly flow: "pkce_loopback" | "device_code";
  /** The requesting client, by display name (never just the opaque client_id). */
  readonly client: { readonly id: string; readonly name: string };
  /** Present for the device-code flow: the device the user-code was entered on. */
  readonly device?: { readonly name: string };
  /** The org the grant is for (the consenting user's active org). */
  readonly org: { readonly id: string; readonly name: string };
  /** Where the request originates — a trust signal. `location` is best-effort and may be null. */
  readonly origin: { readonly ip: string; readonly location: string | null };
  /** The requested capability scopes — rendered as a read-only summary (NO per-scope checklist). */
  readonly scopes: readonly string[];
  /** The resource the resulting token is audience-bound to (e.g. "https://api.webhook.co"). */
  readonly audience: string;
  /** ISO 8601 — when the resulting grant/key expires if approved. */
  readonly expiresAt: string;
}

/**
 * The seam between the consent UI and Lane C's `/authorize` decision endpoint. The live impl POSTs
 * the decision (with the request id + CSRF token) and redirects back to the client; the mock resolves.
 */
export interface ConsentActions {
  /** Record the user's decision for this authorization request. */
  decide(decision: "approve" | "deny"): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mock seam for E4 — replaced by the live client in E8. Records nothing. */
export const mockConsentActions: ConsentActions = {
  async decide() {
    await wait(500);
  },
};

/** A representative fixture so the page renders before Lane C SSRs the real payload (E8). */
export const mockConsentRequest: ConsentRequest = {
  requestId: "areq_mock",
  csrfToken: "csrf_mock",
  flow: "device_code",
  client: { id: "cli_wbhk", name: "webhook CLI" },
  device: { name: "Dana's MacBook Pro" },
  org: { id: "org_personal", name: "Dana's projects" },
  origin: { ip: "203.0.113.7", location: "San Francisco, US" },
  scopes: ["events:read", "events:replay"],
  audience: "https://api.webhook.co",
  expiresAt: "2026-09-18T00:00:00Z",
};

function fmtExpiry(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 font-mono text-xs uppercase tracking-mono-label text-fg-faint sm:w-32">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

export function ConsentForm({
  request,
  actions = mockConsentActions,
}: {
  request: ConsentRequest;
  actions?: ConsentActions;
}) {
  const [pending, setPending] = React.useState<null | "approve" | "deny">(null);
  const [outcome, setOutcome] = React.useState<null | "approve" | "deny">(null);
  const [error, setError] = React.useState<string | null>(null);

  const busy = pending !== null;

  async function decide(decision: "approve" | "deny") {
    setError(null);
    setPending(decision);
    try {
      await actions.decide(decision);
      setOutcome(decision);
    } catch {
      setError("We couldn't record your decision. Please try again.");
    } finally {
      setPending(null);
    }
  }

  if (outcome) {
    const approved = outcome === "approve";
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">
            {approved ? "You're all set" : "Request denied"}
          </h1>
          <p className="leading-snug text-fg-secondary">
            {approved
              ? `${request.client.name} is now authorized. You can return to it and close this window.`
              : `${request.client.name} was not granted access. You can close this window.`}
          </p>
        </div>
      </div>
    );
  }

  const subject = request.device ? request.device.name : request.client.name;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">
          Authorize {request.client.name}
        </h1>
        <p className="leading-snug text-fg-secondary">
          Review the access {request.client.name} is requesting, then approve or deny.
        </p>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <dl className="divide-y divide-hairline rounded-control border border-hairline px-4">
        <SummaryRow label={request.device ? "Device" : "App"}>
          <span className="font-medium">{subject}</span>
          <span className="text-fg-faint"> · {request.client.name}</span>
        </SummaryRow>
        <SummaryRow label="Organization">{request.org.name}</SummaryRow>
        <SummaryRow label="Requesting from">
          {request.origin.location ? `${request.origin.location} · ` : ""}
          <span className="font-mono text-[13px]">{request.origin.ip}</span>
        </SummaryRow>
        <SummaryRow label="Access">
          <span className="flex flex-wrap gap-1.5">
            {request.scopes.map((scope) => (
              <Badge key={scope} tone="neutral" className="font-mono text-xs">
                {scope}
              </Badge>
            ))}
          </span>
        </SummaryRow>
        <SummaryRow label="Expires">
          <span className="font-mono text-[13px]">{fmtExpiry(request.expiresAt)}</span>
        </SummaryRow>
      </dl>

      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <Button variant="secondary" disabled={busy} onClick={() => decide("deny")}>
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button disabled={busy} onClick={() => decide("approve")}>
          {pending === "approve" ? "Authorizing…" : "Authorize"}
        </Button>
      </div>
    </div>
  );
}
