import "server-only";

import { withTenant, type Sql } from "@webhook-co/db/client";
import {
  getReplayDestination,
  listReplayDestinations,
  type ReplayDestinationRecord,
} from "@webhook-co/db/replay-destinations";
import { listSigningSecrets, type SigningSecretMetadata } from "@webhook-co/db/signing-keys";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";

// The replay-destinations read surface for the dashboard (replayDestinations.list / listSigningSecrets).
// A destination is an org-level allowlist entry — a public https URL the engine (or a manual replay) is
// permitted to deliver to. Read live via the Lane fns under withTenant(orgId) as webhook_app; RLS (the
// session orgId) is the tenant backstop, so a cross-org id simply isn't visible. The record carries orgId
// (an internal pointer) — the browser-safe item strips it.

/** A destination row for the dashboard — the db record minus the internal `orgId`. */
export type DestinationItem = Omit<ReplayDestinationRecord, "orgId">;

export type DestinationsResult =
  | { readonly status: "ok"; readonly items: readonly DestinationItem[] }
  | { readonly status: "error" };

export type SigningSecretsResult =
  | { readonly status: "ok"; readonly items: readonly SigningSecretMetadata[] }
  | { readonly status: "not_found" }
  | { readonly status: "error" };

/** The reads this surface needs, injectable for tests; the default binds the per-request tenant pool. */
export interface DestinationReaders {
  list(orgId: string): Promise<ReplayDestinationRecord[]>;
  secrets(orgId: string, destinationId: string): Promise<SigningSecretMetadata[]>;
  /** Resolve a LIVE destination (deleted_at is null) → null for unknown / cross-org / soft-deleted. */
  live(orgId: string, destinationId: string): Promise<{ id: string; url: string } | null>;
}

function boundReaders(app: Sql): DestinationReaders {
  return {
    list: (orgId) => listReplayDestinations(app, orgId),
    secrets: (orgId, destinationId) => listSigningSecrets(app, orgId, destinationId),
    live: (orgId, destinationId) =>
      withTenant(app, orgId, (tx) => getReplayDestination(tx, destinationId)),
  };
}

/** Strip the internal orgId pointer; everything else is safe to render. Shared by the loader + actions. */
export function toDestinationItem(r: ReplayDestinationRecord): DestinationItem {
  const { orgId: _orgId, ...rest } = r;
  return rest;
}

/**
 * Load the org's replay destinations (newest-first, whole set — the list is intentionally un-paginated). A
 * db fault reads as `{status:"error"}` (logged, scrubbed). Tests inject `readers` and skip the pool.
 */
export async function loadDestinations(
  orgId: string,
  readers?: DestinationReaders,
): Promise<DestinationsResult> {
  const load = (r: DestinationReaders) =>
    r.list(orgId).then((rows) => ({ status: "ok" as const, items: rows.map(toDestinationItem) }));
  try {
    if (readers) return await load(readers);
    return await withTenantDb((app) => load(boundReaders(app)));
  } catch (error) {
    logActionError("destinations.load", error);
    return { status: "error" };
  }
}

/**
 * Load a destination's signing-secret history as metadata only (id/status/createdAt) — never the sealed
 * bytes or the plaintext (the db read selects no ciphertext columns). A missing/cross-org destination
 * simply yields an empty list under RLS (no existence oracle).
 */
export async function loadSigningSecrets(
  orgId: string,
  destinationId: string,
  readers?: DestinationReaders,
): Promise<SigningSecretsResult> {
  // Resolve the destination FIRST (mirrors the api handler): a soft-deleted / unknown / cross-org id is
  // NOT_FOUND, not an empty list — keeping the web surface at parity with api/cli.
  const load = async (r: DestinationReaders): Promise<SigningSecretsResult> => {
    const live = await r.live(orgId, destinationId);
    if (!live) return { status: "not_found" };
    const items = await r.secrets(orgId, destinationId);
    return { status: "ok", items };
  };
  try {
    if (readers) return await load(readers);
    return await withTenantDb((app) => load(boundReaders(app)));
  } catch (error) {
    logActionError("destinations.load_secrets", error);
    return { status: "error" };
  }
}
