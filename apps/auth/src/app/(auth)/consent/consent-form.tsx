"use client";

import type { ConsentRequest } from "@webhook-co/contract";
import { Badge, Banner, Button } from "@webhook-co/ui";
import * as React from "react";

// The consent grant-summary payload Lane C's `/authorize` SSRs into this page — the C↔E consent contract,
// now the shared @webhook-co/contract definition (A3 promoted it from this mock). It carries BOTH durations
// (grantExpiresAt = the ~90d grant ceiling; keyTtlSeconds = the ~24h access-key TTL), rendered below.
// Re-exported for the existing page imports.
export type { ConsentRequest };

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
  grantExpiresAt: "2026-09-18T00:00:00Z",
  keyTtlSeconds: 86_400,
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
        {/* Renders the grant ceiling. Lane E (E8) adds a row for `request.keyTtlSeconds` (the ~24h key
            TTL) so the screen shows BOTH durations — the contract now provides it. */}
        <SummaryRow label="Authorized until">
          <span className="font-mono text-[13px]">{fmtExpiry(request.grantExpiresAt)}</span>
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
