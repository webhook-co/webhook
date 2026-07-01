import type {
  AddedProviderSecret,
  CreatedEndpoint,
  DeletedEndpoint,
  ProviderSecretSummary,
  ReplayDestinationDeleted,
  RevokedProviderSecret,
  SubscriptionDeleted,
} from "@webhook-co/contract";
import type {
  Delivery,
  Endpoint,
  Event,
  EventSummary,
  ReplayDestination,
  Subscription,
} from "@webhook-co/shared";

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

// The Tier-4 weaker authenticity word — a DISTINCT yellow "authenticated" (a shared static token / HTTP
// Basic match, not a payload signature) so it never reads as the green cryptographic "verified".
function authnWord(color: boolean): string {
  return colorize("authenticated", "yellow", color);
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
      e.verificationState === "authenticated" ? authnWord(color) : verifiedWord(e.verified, color),
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
    ["URL", "LABEL", "ORDERED", "STATE", "CREATED", "ID"],
    items.map((d) => [
      field(d.url),
      d.label === null ? NONE : field(d.label),
      d.ordered ? "strict" : "best-effort",
      d.disabledAt === null ? "enabled" : "disabled",
      fmtDate(d.createdAt),
      field(d.id),
    ]),
  );
}

/** A single replay destination as a block — url + delivery mode + enable state. */
export function renderReplayDestination(d: ReplayDestination): string {
  return block([
    ["id", field(d.id)],
    ["url", field(d.url)],
    ["label", d.label === null ? NONE : field(d.label)],
    ["ordering", d.ordered ? "strict FIFO" : "best-effort"],
    ["state", d.disabledAt === null ? "enabled" : `disabled (${fmtDateTime(d.disabledAt)})`],
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

/** The org's delivery subscriptions as a table (S3 Slice 3). */
export function renderSubscriptionsTable(items: readonly Subscription[]): string {
  return renderTable(
    ["SOURCE ENDPOINT", "DESTINATION", "PROVIDER", "EVENT TYPES", "VERIFIED", "ENABLED", "ID"],
    items.map((s) => [
      field(s.sourceEndpointId),
      field(s.destinationId),
      s.provider === null ? "any" : field(s.provider),
      field(s.eventTypes.join(", ")),
      s.requireVerified ? "required" : NONE,
      s.enabled ? "yes" : "paused",
      field(s.id),
    ]),
  );
}

/** A created/updated delivery subscription as a block. */
export function renderSubscription(s: Subscription): string {
  return block([
    ["id", field(s.id)],
    ["source endpoint", field(s.sourceEndpointId)],
    ["destination", field(s.destinationId)],
    ["provider", s.provider === null ? "any" : field(s.provider)],
    ["event types", field(s.eventTypes.join(", "))],
    ["require verified", s.requireVerified ? "yes" : "no"],
    ["enabled", s.enabled ? "yes" : "paused"],
    ["created", fmtDateTime(s.createdAt)],
  ]);
}

/** A just-removed subscription: its id. */
export function renderRemovedSubscription(s: SubscriptionDeleted): string {
  return block([
    ["id", field(s.id)],
    ["removed", "yes"],
  ]);
}

/** The org's outbound deliveries as a newest-first table. */
export function renderDeliveriesTable(items: readonly Delivery[]): string {
  return renderTable(
    ["CREATED", "STATUS", "ATTEMPT", "CODE", "DESTINATION", "ID"],
    items.map((d) => [
      fmtDateTime(d.createdAt),
      field(d.status),
      String(d.attempt),
      d.statusCode === null ? NONE : String(d.statusCode),
      d.destinationId === null ? NONE : field(d.destinationId),
      field(d.id),
    ]),
  );
}

/** A single outbound delivery as a block — status, retry clock, and the event/destination it links. */
export function renderDelivery(d: Delivery): string {
  return block([
    ["id", field(d.id)],
    ["event", field(d.eventId)],
    ["destination", d.destinationId === null ? NONE : field(d.destinationId)],
    ["subscription", d.subscriptionId === null ? NONE : field(d.subscriptionId)],
    ["status", field(d.status)],
    ["attempt", String(d.attempt)],
    ["status code", d.statusCode === null ? NONE : String(d.statusCode)],
    ["error", d.error === null ? NONE : field(d.error)],
    ["next retry", d.nextRetryAt === null ? NONE : fmtDateTime(d.nextRetryAt)],
    ["created", fmtDateTime(d.createdAt)],
  ]);
}

/** `verified`/`authenticated`/`unverified`, annotated with the signing scheme (on pass) or the failure
 *  code (on fail). A Tier-4 token/basic pass reads `authenticated (<scheme>, non-cryptographic)`. */
function verifiedDetail(e: Event, color: boolean): string {
  if (e.verification === null) return verifiedWord(e.verified, color);
  if (e.verification.ok) {
    if (e.verification.authenticity !== undefined) {
      return `${authnWord(color)} (${field(e.verification.scheme)}, non-cryptographic)`;
    }
    return `${verifiedWord(e.verified, color)} (${field(e.verification.scheme)})`;
  }
  return `${verifiedWord(e.verified, color)} (${field(e.verification.reason.code)})`;
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
