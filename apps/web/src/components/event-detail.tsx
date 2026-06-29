"use client";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import * as React from "react";

import { formatDateTime } from "@/lib/format";
import { verificationCopy } from "@/lib/verification-copy";
import type { DetailHeader, EventDetailItem, RevealHeaderResult } from "@/server/events";
import type { PayloadResult } from "@/server/payloads";

import { PayloadViewer } from "./payload-viewer";

/** Reveal one sensitive header value (server action; re-reads under RLS). Injected by the gated page. */
type RevealHeaderFn = (input: {
  endpointId: string;
  eventId: string;
  index: number;
}) => Promise<RevealHeaderResult>;

export interface EventDetailProps {
  event: EventDetailItem;
  endpointId: string;
  revealHeader: RevealHeaderFn;
  /** Load the event body for the inline preview (server action). Injected by the gated page. */
  loadPayload: (input: { endpointId: string; eventId: string }) => Promise<PayloadResult>;
}

export function EventDetail({ event, endpointId, revealHeader, loadPayload }: EventDetailProps) {
  const verification = verificationCopy(event.verification);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Event</CardTitle>
          <StatusPill tone={verification.tone}>{verification.pill}</StatusPill>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-secondary">Event ID</dt>
            <dd className="flex items-center gap-2">
              <code className="font-mono text-fg">{event.id}</code>
              <CopyButton value={event.id} size="sm" />
            </dd>
            <dt className="text-fg-secondary">Received</dt>
            <dd className="text-fg">{formatDateTime(event.receivedAt)}</dd>
            <dt className="text-fg-secondary">Provider</dt>
            <dd className="text-fg">{event.provider ?? "—"}</dd>
            <dt className="text-fg-secondary">Content type</dt>
            <dd className="text-fg">{event.contentType ?? "—"}</dd>
            <dt className="text-fg-secondary">Payload size</dt>
            <dd className="text-fg">{event.payloadBytes} bytes</dd>
            <dt className="text-fg-secondary">Dedup</dt>
            <dd className="flex items-center gap-2">
              <span className="text-fg">{event.dedupStrategy}</span>
              <code className="font-mono text-xs text-fg-secondary">{event.dedupKey}</code>
            </dd>
            {event.providerEventId ? (
              <>
                <dt className="text-fg-secondary">Provider event ID</dt>
                <dd className="font-mono text-fg">{event.providerEventId}</dd>
              </>
            ) : null}
            {event.externalId ? (
              <>
                <dt className="text-fg-secondary">External ID</dt>
                <dd className="font-mono text-fg">{event.externalId}</dd>
              </>
            ) : null}
          </dl>
          <p className="leading-snug text-fg-secondary">{verification.detail}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payload</CardTitle>
        </CardHeader>
        <CardContent>
          <PayloadViewer
            endpointId={endpointId}
            eventId={event.id}
            payloadBytes={event.payloadBytes}
            contentType={event.contentType}
            loadPayload={loadPayload}
            downloadHref={`/endpoints/${endpointId}/events/${event.id}/payload`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Headers</CardTitle>
        </CardHeader>
        <CardContent>
          <HeadersTable
            headers={event.headers}
            endpointId={endpointId}
            eventId={event.id}
            revealHeader={revealHeader}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inspect from your terminal</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="leading-snug text-fg-secondary">
            View the raw payload, or replay this event to your local server, with the CLI:
          </p>
          <CommandLine command={`wbhk events payload ${event.id}`} />
          <CommandLine
            command={`wbhk replay ${event.id} --forward http://localhost:3000/webhooks`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Per-row reveal status (one source of truth, so the button/dots/error/value can't desync). */
type RevealState = { kind: "pending" } | { kind: "error" } | { kind: "revealed"; value: string };

/**
 * The ordered, unscrubbed inbound headers. A sensitive header (anything not on the safe allowlist) is
 * REDACTED server-side — its value isn't in the props; the user reveals it on demand, which fetches the
 * value via a server action that re-reads the event under RLS. Every value (inline or revealed) is
 * rendered as React-escaped text (never dangerouslySetInnerHTML) — the headers are attacker-controlled,
 * and output-escaping is the XSS defense the CSP relies on.
 */
function HeadersTable({
  headers,
  endpointId,
  eventId,
  revealHeader,
}: {
  headers: readonly DetailHeader[];
  endpointId: string;
  eventId: string;
  revealHeader: RevealHeaderFn;
}) {
  const [states, setStates] = React.useState<ReadonlyMap<number, RevealState>>(() => new Map());

  if (headers.length === 0) {
    return (
      <Table>
        <TableBody>
          <TableEmpty colSpan={2}>No headers were captured for this event.</TableEmpty>
        </TableBody>
      </Table>
    );
  }

  function setState(index: number, state: RevealState) {
    setStates((prev) => new Map(prev).set(index, state));
  }

  async function handleReveal(index: number) {
    if (states.get(index)?.kind === "pending") return;
    setState(index, { kind: "pending" });
    let result: RevealHeaderResult;
    try {
      result = await revealHeader({ endpointId, eventId, index });
    } catch {
      result = { ok: false };
    }
    setState(index, result.ok ? { kind: "revealed", value: result.value } : { kind: "error" });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {headers.map((header, index) => {
          const state = states.get(index);
          const revealed = state?.kind === "revealed";
          // Sensitive + not-yet-revealed → masked (revealed state is explicit, so an empty revealed value
          // still unmasks correctly rather than reading as "not revealed").
          const masked = header.sensitive && !revealed;
          return (
            <TableRow key={`${index}-${header.name}`}>
              <TableCell className="align-top font-mono text-xs text-fg-secondary">
                {header.name}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {masked ? (
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="text-fg-faint">
                      ••••••••••
                    </span>
                    <span className="sr-only">hidden sensitive value</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={state?.kind === "pending"}
                      onClick={() => handleReveal(index)}
                    >
                      {state?.kind === "pending" ? "Revealing…" : "Reveal"}
                    </Button>
                    {state?.kind === "error" ? (
                      <span role="alert" className="text-danger">
                        Couldn&apos;t reveal — try again.
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <HeaderValue
                    value={revealed ? (state as { value: string }).value : header.value}
                  />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** A header value as React-escaped text; an empty value shows a muted "(empty)" so it doesn't read blank. */
function HeaderValue({ value }: { value: string | null }) {
  if (value === null || value === "") {
    return <span className="text-fg-faint">(empty)</span>;
  }
  return <span className="break-all text-fg">{value}</span>;
}

/** A copyable one-line CLI command, rendered as escaped monospace text. */
function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-control border border-hairline bg-surface-sunken p-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{command}</code>
      <CopyButton value={command} size="sm" />
    </div>
  );
}
