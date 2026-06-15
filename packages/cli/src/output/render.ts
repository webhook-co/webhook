import type { Endpoint, Event, EventSummary } from "@webhook-co/shared";

import type { AuditVerifyResult } from "../api-client.js";
import { colorize } from "./color.js";
import { renderTable } from "./table.js";

// Text renderers for the read commands: aligned tables for the list views, key:value blocks for a
// single record, and a one-line result for `audit verify`. Color is applied only to status tokens and
// is gated on the caller's `colorEnabled`. The machine view (`--output json`) is handled separately by
// renderJson — these are the human views, so exact spacing here is reviewed by eye (human-UI gate).

/** Placeholder for an absent value (a null provider), so a blank cell is never ambiguous. */
const NONE = "—";

function statusWord(paused: boolean, color: boolean): string {
  return paused ? colorize("paused", "yellow", color) : colorize("active", "green", color);
}

function verifiedWord(verified: boolean, color: boolean): string {
  return verified ? colorize("verified", "green", color) : colorize("unverified", "red", color);
}

/** Date only — endpoints' createdAt. */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Full ISO timestamp — events' receivedAt (exactness matters for a webhook/audit tool). */
function fmtDateTime(d: Date): string {
  return d.toISOString();
}

export function renderEndpointsTable(items: readonly Endpoint[], color: boolean): string {
  return renderTable(
    ["NAME", "STATUS", "CREATED", "ID"],
    items.map((e) => [e.name, statusWord(e.paused, color), fmtDate(e.createdAt), e.id]),
  );
}

export function renderEventsTable(items: readonly EventSummary[], color: boolean): string {
  return renderTable(
    ["RECEIVED", "PROVIDER", "VERIFIED", "ID"],
    items.map((e) => [
      fmtDateTime(e.receivedAt),
      e.provider ?? NONE,
      verifiedWord(e.verified, color),
      e.id,
    ]),
  );
}

/** A left-aligned key:value block (the `whoami` idiom), keys padded to a common width. */
function block(rows: readonly (readonly [string, string])[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${`${key}:`.padEnd(width + 1)} ${value}`).join("\n");
}

export function renderEndpoint(e: Endpoint, color: boolean): string {
  return block([
    ["id", e.id],
    ["name", e.name],
    ["status", statusWord(e.paused, color)],
    ["created", fmtDateTime(e.createdAt)],
  ]);
}

/** `verified`/`unverified`, annotated with the signing scheme (on pass) or the failure code (on fail). */
function verifiedDetail(e: Event, color: boolean): string {
  const word = verifiedWord(e.verified, color);
  if (e.verification === null) return word;
  if (e.verification.ok) return `${word} (${e.verification.scheme})`;
  return `${word} (${e.verification.reason.code})`;
}

export function renderEvent(e: Event, color: boolean): string {
  return block([
    ["id", e.id],
    ["endpoint", e.endpointId],
    ["received", fmtDateTime(e.receivedAt)],
    ["provider", e.provider ?? NONE],
    ["verified", verifiedDetail(e, color)],
    ["content-type", e.contentType ?? NONE],
    ["size", `${e.payloadBytes} bytes`],
    ["headers", `${e.headers.length}`],
    ["dedup", `${e.dedupStrategy} (${e.dedupKey})`],
  ]);
}

export function renderAuditResult(result: AuditVerifyResult, color: boolean): string {
  if (result.ok) {
    return `${colorize("verified", "green", color)} — audit chain intact (${result.rowsVerified} rows)`;
  }
  const b = result.break;
  return `${colorize("BROKEN", "red", color)} — audit chain break at seq ${b.seq}: ${b.kind} — ${b.detail} (${result.rowsVerified} rows verified before the break)`;
}
