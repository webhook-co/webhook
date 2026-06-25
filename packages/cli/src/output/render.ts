import type { CreatedEndpoint, DeletedEndpoint } from "@webhook-co/contract";
import type { Endpoint, Event, EventSummary } from "@webhook-co/shared";

import type { AuditVerifyResult } from "../api-client.js";
import { colorize } from "./color.js";
import { sanitizeControl } from "./safe-text.js";
import { renderTable } from "./table.js";

// Text renderers for the read commands: aligned tables for the list views, key:value blocks for a
// single record, and a one-line result for `audit verify`. Color is applied only to status tokens and
// is gated on the caller's `colorEnabled`. The machine view (`--output json`) is handled separately by
// renderJson — these are the human views, so exact spacing here is reviewed by eye (human-UI gate).
//
// Every SERVER-controlled string (names, ids, providers, dedup keys, content types, audit-break details)
// passes through `field()` first so a hostile value can't inject a terminal-control sequence or break
// alignment; the locally-generated tokens (colorize output, formatted dates, byte counts) are trusted
// and bypass it — so our own color ANSI survives.

/** Placeholder for an absent value (a null provider), so a blank cell is never ambiguous. */
const NONE = "—";

/** Sanitize a server-controlled string before it lands in a human text view. */
const field = (value: string): string => sanitizeControl(value);

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
    items.map((e) => [
      field(e.name),
      statusWord(e.paused, color),
      fmtDate(e.createdAt),
      field(e.id),
    ]),
  );
}

export function renderEventsTable(items: readonly EventSummary[], color: boolean): string {
  return renderTable(
    ["RECEIVED", "PROVIDER", "VERIFIED", "ID"],
    items.map((e) => [
      fmtDateTime(e.receivedAt),
      e.provider === null ? NONE : field(e.provider),
      verifiedWord(e.verified, color),
      field(e.id),
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
    ["id", field(e.id)],
    ["name", field(e.name)],
    ["status", statusWord(e.paused, color)],
    ["created", fmtDateTime(e.createdAt)],
  ]);
}

/**
 * A just-created endpoint, including the one-time ingest URL (which embeds the secret token). The
 * "save this" caveat is printed separately to stderr by the command so stdout stays the record.
 */
export function renderCreatedEndpoint(e: CreatedEndpoint, color: boolean): string {
  return block([
    ["id", field(e.id)],
    ["name", field(e.name)],
    ["status", statusWord(e.paused, color)],
    ["created", fmtDateTime(e.createdAt)],
    ["ingest url", field(e.ingestUrl)],
  ]);
}

/** A just soft-deleted endpoint: its id + when it was deleted (the `endpoints delete` confirmation). */
export function renderDeletedEndpoint(d: DeletedEndpoint): string {
  return block([
    ["id", field(d.id)],
    ["deleted", fmtDateTime(d.deletedAt)],
  ]);
}

/** `verified`/`unverified`, annotated with the signing scheme (on pass) or the failure code (on fail). */
function verifiedDetail(e: Event, color: boolean): string {
  const word = verifiedWord(e.verified, color);
  if (e.verification === null) return word;
  if (e.verification.ok) return `${word} (${field(e.verification.scheme)})`;
  return `${word} (${field(e.verification.reason.code)})`;
}

export function renderEvent(e: Event, color: boolean): string {
  return block([
    ["id", field(e.id)],
    ["endpoint", field(e.endpointId)],
    ["received", fmtDateTime(e.receivedAt)],
    ["provider", e.provider === null ? NONE : field(e.provider)],
    ["verified", verifiedDetail(e, color)],
    ["content-type", e.contentType === null ? NONE : field(e.contentType)],
    ["size", `${e.payloadBytes} bytes`],
    ["headers", `${e.headers.length}`],
    ["dedup", `${field(e.dedupStrategy)} (${field(e.dedupKey)})`],
  ]);
}

export function renderAuditResult(result: AuditVerifyResult, color: boolean): string {
  if (result.ok) {
    return `${colorize("verified", "green", color)} — audit chain intact (${result.rowsVerified} rows)`;
  }
  const b = result.break;
  return `${colorize("BROKEN", "red", color)} — audit chain break at seq ${b.seq}: ${field(b.kind)} — ${field(b.detail)} (${result.rowsVerified} rows verified before the break)`;
}
