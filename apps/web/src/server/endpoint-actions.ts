"use server";

import { logActionError } from "./action-log";
import {
  createEndpoint,
  deleteEndpoint,
  rotateEndpoint,
  type MintedEndpoint,
} from "./endpoint-mutations";
import { isUuid, type EndpointItem } from "./endpoints";
import { verifySession } from "./session";

/**
 * The fault code of a Lane B CapabilityFault, duck-typed by `name` + `code` (not `instanceof`, so it is
 * robust across the contract-module boundary), else null. The db fns throw `CapabilityFault("RATE_LIMITED")`
 * at the per-org cap and `CapabilityFault("NOT_FOUND")` for an unknown id; surfacing those distinctly keeps
 * the dashboard at parity with the api/cli/mcp error taxonomy instead of collapsing a terminal error into a
 * misleading "please try again". (Not exported — "use server" files may only export async actions.)
 */
function faultCode(error: unknown): string | null {
  const e = error as { name?: string; code?: string };
  return e?.name === "CapabilityFault" ? (e.code ?? null) : null;
}

export type CreateEndpointResult =
  | { readonly ok: true; readonly endpoint: EndpointItem; readonly ingestUrl: string }
  | { readonly ok: false; readonly error: string };

export type EndpointActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type RotateEndpointResult =
  | { readonly ok: true; readonly ingestUrl: string }
  | { readonly ok: false; readonly error: string };

// Mirrors the contract capability input `z.string().trim().min(1).max(200)` so the dashboard accepts
// exactly what api/cli/mcp accept — no stricter, parity-breaking web-only limit.
const MAX_NAME_LEN = 200;

function toItem(m: MintedEndpoint): EndpointItem {
  return { id: m.id, name: m.name, paused: m.paused, createdAt: m.createdAt };
}

/**
 * Create an endpoint. Authz is the session + RLS-org-pinning (any org member may manage the org's
 * endpoints — matching the credential dashboard; a per-action role gate is a documented future add). The
 * ingest URL embeds the freshly-minted token and is returned ONCE, only as this action result.
 */
export async function createEndpointAction(input: { name: string }): Promise<CreateEndpointResult> {
  const session = await verifySession();
  // Runtime type guard: TS types are erased, so a crafted server-action POST can deliver a non-string —
  // coerce-guard before .trim() so a bad payload returns a graceful error, not an unhandled 500.
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the endpoint a name." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.` };
  }

  let minted: MintedEndpoint;
  try {
    minted = await createEndpoint({ orgId: session.orgId, userId: session.userId, name });
  } catch (error) {
    logActionError("endpoint.create_failed", error);
    if (faultCode(error) === "RATE_LIMITED") {
      return { ok: false, error: "You've reached the endpoint limit for this org." };
    }
    return { ok: false, error: "We couldn't create the endpoint. Please try again." };
  }
  // Map OUTSIDE the try: the endpoint is already committed, so a throw while shaping the result must NOT be
  // reported as a failure (that would tell the user nothing was created while a live endpoint + URL exist).
  return { ok: true, endpoint: toItem(minted), ingestUrl: minted.ingestUrl };
}

/**
 * Rotate an endpoint's ingest token — a HARD cutover: the old URL stops resolving immediately. Returns the
 * NEW one-time ingest URL. The id/name/paused/createdAt and the endpoint's captured events are preserved.
 */
export async function rotateEndpointAction(endpointId: string): Promise<RotateEndpointResult> {
  const session = await verifySession();
  if (typeof endpointId !== "string" || !endpointId.trim()) {
    return { ok: false, error: "Missing endpoint id." };
  }
  // A non-uuid can never name an endpoint — treat it as gone (a clean error) rather than letting the db
  // raise 22P02 → a misleading retryable error (parity with the api/cli/mcp uuid input validation).
  if (!isUuid(endpointId)) return { ok: false, error: "That endpoint no longer exists." };
  let minted: MintedEndpoint;
  try {
    minted = await rotateEndpoint({ orgId: session.orgId, userId: session.userId, endpointId });
  } catch (error) {
    logActionError("endpoint.rotate_failed", error);
    if (faultCode(error) === "NOT_FOUND") {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    return { ok: false, error: "We couldn't rotate the endpoint. Please try again." };
  }
  return { ok: true, ingestUrl: minted.ingestUrl };
}

/**
 * Soft-delete an endpoint — it stops receiving webhooks immediately, but its past events stay inspectable.
 * Idempotent at the db. `{ok:false}` means the mutation itself failed (not a stale ingest-cache entry).
 */
export async function deleteEndpointAction(endpointId: string): Promise<EndpointActionResult> {
  const session = await verifySession();
  if (typeof endpointId !== "string" || !endpointId.trim()) {
    return { ok: false, error: "Missing endpoint id." };
  }
  if (!isUuid(endpointId)) return { ok: false, error: "That endpoint no longer exists." };
  try {
    await deleteEndpoint({ orgId: session.orgId, userId: session.userId, endpointId });
    return { ok: true };
  } catch (error) {
    logActionError("endpoint.delete_failed", error);
    if (faultCode(error) === "NOT_FOUND") {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    return { ok: false, error: "We couldn't delete the endpoint. Please try again." };
  }
}
