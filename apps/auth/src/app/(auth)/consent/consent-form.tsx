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

/**
 * Why a consent decision couldn't be recorded, beyond a generic transient failure — surfaced as a
 * friendly terminal rather than a retry prompt. `already_decided` ← HTTP 409 (the request was already
 * approved/denied, typically a back-button re-POST); `expired` ← HTTP 400 (the underlying device/auth
 * request lapsed). The live client ({@link makeConsentActions}) raises this; everything else falls to
 * the generic catch.
 */
export type ConsentDecisionFailure = "already_decided" | "expired";

export class ConsentDecisionError extends Error {
  constructor(readonly reason: ConsentDecisionFailure) {
    super(reason);
    this.name = "ConsentDecisionError";
  }
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
  origin: {
    ip: "203.0.113.7",
    location: "US",
    city: "San Francisco",
    region: "California",
    regionCode: "CA",
  },
  scopes: ["events:read", "events:replay"],
  audience: "https://api.webhook.co",
  grantExpiresAt: "2026-09-18T00:00:00Z",
  keyTtlSeconds: 86_400,
};

function fmtExpiry(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
}

/**
 * A country's flag emoji from its ISO-3166 alpha-2 code, via Unicode regional-indicator symbols
 * (A→🇦 … Z→🇿). Returns "" for anything that isn't exactly two ASCII letters, so a null/blank/malformed
 * `location` renders no flag rather than stray glyphs. (Platforms without flag glyphs degrade to the two
 * letters, still meaningful.)
 */
export function flagFromCountry(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "";
  const A = 0x1f1e6; // REGIONAL INDICATOR SYMBOL LETTER A
  const cc = code.toUpperCase();
  return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65));
}

/**
 * A human place label for the request origin: the most specific available locality (city, else region)
 * joined with the 2-letter country — e.g. "Lisbon, PT", "PT", or "Lisbon". Returns "" when no geo at all
 * resolved (the row then shows just the IP). The country flag is rendered separately + `aria-hidden` (it's
 * decorative — the 2-letter code already carries the country). All geo fields are best-effort/nullable.
 */
function originPlaceLabel(origin: ConsentRequest["origin"]): string {
  const locality = origin.city ?? origin.region ?? null;
  const country = origin.location ?? null;
  return [locality, country].filter(Boolean).join(", ");
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
  const [outcome, setOutcome] = React.useState<null | "approve" | "deny" | ConsentDecisionFailure>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  const busy = pending !== null;

  async function decide(decision: "approve" | "deny") {
    setError(null);
    setPending(decision);
    try {
      await actions.decide(decision);
      setOutcome(decision);
    } catch (err) {
      // 409/400 → a definitive terminal (re-submitting won't help); anything else is retryable.
      if (err instanceof ConsentDecisionError) {
        setOutcome(err.reason);
      } else {
        setError("We couldn't record your decision. Please try again.");
      }
    } finally {
      setPending(null);
    }
  }

  if (outcome) {
    const terminal = {
      approve: {
        title: "You're all set",
        body: `${request.client.name} is now authorized. You can return to it and close this window.`,
      },
      deny: {
        title: "Request denied",
        body: `${request.client.name} was not granted access. You can close this window.`,
      },
      already_decided: {
        title: "Already completed",
        body: "This request has already been completed. You can close this window.",
      },
      expired: {
        title: "Request expired",
        body: "This request has expired. Start over from the app or device that sent you here.",
      },
    }[outcome];
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">{terminal.title}</h1>
          <p className="leading-snug text-fg-secondary">{terminal.body}</p>
        </div>
      </div>
    );
  }

  const subject = request.device ? request.device.name : request.client.name;
  const placeLabel = originPlaceLabel(request.origin);
  const placeFlag = flagFromCountry(request.origin.location);

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
          {/* The "· app" suffix names the app accessing the device — only meaningful in the Device row.
              In the App row the subject IS the app, so the suffix would just repeat it. */}
          {request.device ? <span className="text-fg-faint"> · {request.client.name}</span> : null}
        </SummaryRow>
        <SummaryRow label="Organization">{request.org.name}</SummaryRow>
        <SummaryRow label="Requesting from">
          <div className="flex flex-col gap-0.5">
            {placeLabel ? (
              <span>
                {placeLabel}
                {placeFlag ? <span aria-hidden="true"> {placeFlag}</span> : null}
              </span>
            ) : null}
            <span className="break-all font-mono text-[13px]">{request.origin.ip}</span>
          </div>
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
