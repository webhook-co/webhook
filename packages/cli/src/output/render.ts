import type {
  AddedProviderSecret,
  CreatedEndpoint,
  DeletedEndpoint,
  ProviderSecretSummary,
  ReplayDestinationDeleted,
  RevokedProviderSecret,
} from "@webhook-co/contract";
import type { Endpoint, Event, EventSummary, ReplayDestination } from "@webhook-co/shared";

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

/** Color a provider secret's lifecycle status (active/retiring/revoked). */
function secretStatusWord(status: string, color: boolean): string {
  if (status === "active") return colorize("active", "green", color);
  if (status === "retiring") return colorize("retiring", "yellow", color);
  return colorize("revoked", "red", color);
}

/** An endpoint's provider secrets as a metadata table — never the sealed bytes/plaintext. */
export function renderProviderSecretsTable(
  items: readonly ProviderSecretSummary[],
  color: boolean,
): string {
  return renderTable(
    ["PROVIDER", "STATUS", "LABEL", "CREATED", "ID"],
    items.map((s) => [
      field(s.provider),
      secretStatusWord(s.status, color),
      s.label === null ? NONE : field(s.label),
      fmtDate(s.createdAt),
      field(s.id),
    ]),
  );
}

/** A just-registered provider secret (id/provider/status) — the plaintext is never shown. */
export function renderAddedProviderSecret(s: AddedProviderSecret, color: boolean): string {
  return block([
    ["id", field(s.id)],
    ["provider", field(s.provider)],
    ["status", secretStatusWord(s.status, color)],
  ]);
}

/** A just-revoked provider secret: its id + when it was revoked. */
export function renderRevokedProviderSecret(r: RevokedProviderSecret): string {
  return block([
    ["id", field(r.id)],
    ["revoked", fmtDateTime(r.revokedAt)],
  ]);
}

// The list + add surfaces only ever show LIVE (active) destinations — list filters `deleted_at is null`
// server-side and add returns a freshly-inserted row — so a STATUS column would be a constant "active".
// It is omitted from the human views (the full record, status included, is still in `--output json`); a
// future revoked-history view would reintroduce it.

/** The org's replay-destination allowlist as a table (ADR-0081). */
export function renderReplayDestinationsTable(items: readonly ReplayDestination[]): string {
  return renderTable(
    ["URL", "LABEL", "CREATED", "ID"],
    items.map((d) => [
      field(d.url),
      d.label === null ? NONE : field(d.label),
      fmtDate(d.createdAt),
      field(d.id),
    ]),
  );
}

/** A just-registered replay destination — the canonical stored url + id. */
export function renderReplayDestination(d: ReplayDestination): string {
  return block([
    ["id", field(d.id)],
    ["url", field(d.url)],
    ["label", d.label === null ? NONE : field(d.label)],
    ["created", fmtDateTime(d.createdAt)],
  ]);
}

/** A just-removed replay destination: its id + when it was removed. */
export function renderRemovedReplayDestination(d: ReplayDestinationDeleted): string {
  return block([
    ["id", field(d.id)],
    ["removed", fmtDateTime(d.deletedAt)],
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
