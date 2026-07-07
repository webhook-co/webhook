"use server";

import { DedupConfigSchema, type DedupConfig } from "@webhook-co/shared";
import { revalidatePath } from "next/cache";

import { logActionError } from "./action-log";
import {
  createEndpoint,
  deleteEndpoint,
  rotateEndpoint,
  updateEndpointDedup,
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
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export type RotateEndpointResult =
  | { readonly ok: true; readonly ingestUrl: string }
  | { readonly ok: false; readonly error: string };

export type UpdateEndpointDedupResult =
  | { readonly ok: true; readonly dedupConfig: DedupConfig | null }
  | { readonly ok: false; readonly error: string };

// Mirrors the contract capability input `z.string().trim().min(1).max(200)` so the dashboard accepts
// exactly what api/cli/mcp accept — no stricter, parity-breaking web-only limit.
const MAX_NAME_LEN = 200;

function toItem(m: MintedEndpoint): EndpointItem {
  return {
    id: m.id,
    name: m.name,
    paused: m.paused,
    createdAt: m.createdAt,
    dedupConfig: m.dedupConfig,
  };
}

/**
 * Create an endpoint. Authz is the session + RLS-org-pinning (any org member may manage the org's
 * endpoints — matching the credential dashboard; a per-action role gate is a documented future add). The
 * ingest URL embeds the freshly-minted token and is returned ONCE, only as this action result.
 */
export async function createEndpointAction(input: {
  name: string;
  dedupConfig?: DedupConfig | null;
}): Promise<CreateEndpointResult> {
  const session = await verifySession();
  // Runtime type guard: TS types are erased, so a crafted server-action POST can deliver a non-string —
  // coerce-guard before .trim() so a bad payload returns a graceful error, not an unhandled 500.
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Give the endpoint a name." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the name under ${MAX_NAME_LEN} characters.` };
  }
  // Validate the dedup config (untrusted, like the name) ONLY when supplied — an omitted config keeps the
  // default (off — log every request). The server is authoritative even though the dialog sends structured data.
  let dedupConfig: DedupConfig | null | undefined;
  if (input?.dedupConfig !== undefined) {
    const parsed = DedupConfigSchema.nullable().safeParse(input.dedupConfig);
    if (!parsed.success) return { ok: false, error: "That deduplication config isn't valid." };
    dedupConfig = parsed.data;
  }

  let minted: MintedEndpoint;
  try {
    minted = await createEndpoint({
      orgId: session.orgId,
      userId: session.userId,
      name,
      ...(dedupConfig !== undefined ? { dedupConfig } : {}),
    });
  } catch (error) {
    logActionError("endpoint.create_failed", error);
    if (faultCode(error) === "RATE_LIMITED") {
      return { ok: false, error: "You've reached the endpoint limit for this org." };
    }
    return { ok: false, error: "We couldn't create the endpoint. Please try again." };
  }
  // Map OUTSIDE the try: the endpoint is already committed, so a throw while shaping the result must NOT be
  // reported as a failure (that would tell the user nothing was created while a live endpoint + URL exist).
  // No revalidatePath here: create never navigates — EndpointsManager prepends the new row optimistically
  // and stays on /endpoints; a later real navigation re-runs loadEndpoints (the page is dynamic via
  // cookies()), so revalidating would only run a verifySession + DB round-trip whose RSC nothing renders.
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
 * Update an endpoint's deduplication config (ADR-0104). null resets to the default (off — log every request).
 * The change persists + audits, then evicts the endpoint's KV ingest-cache entry so the engine reads the new
 * config within the propagation window. The config is UNTRUSTED (a crafted POST can send any shape), so it is
 * re-validated against the same schema the api/mcp surfaces use before it reaches the db.
 */
export async function updateEndpointDedupAction(input: {
  endpointId: string;
  dedupConfig: DedupConfig | null;
}): Promise<UpdateEndpointDedupResult> {
  const session = await verifySession();
  const endpointId = input?.endpointId;
  if (typeof endpointId !== "string" || !endpointId.trim()) {
    return { ok: false, error: "Missing endpoint id." };
  }
  // A non-uuid can never name an endpoint — treat it as gone (parity with rotate/delete + the api/cli/mcp
  // uuid input validation) rather than letting the db raise 22P02 → a misleading retryable error.
  if (!isUuid(endpointId)) return { ok: false, error: "That endpoint no longer exists." };
  // Re-validate the config server-side: `nullable` so null (reset to default) is accepted, and the schema's
  // superRefine enforces the mode/fields coupling + the window + field-path grammar the engine relies on.
  const parsed = DedupConfigSchema.nullable().safeParse(input?.dedupConfig);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That deduplication config isn't valid. Check the fields and window.",
    };
  }

  let result: { dedupConfig: DedupConfig | null };
  try {
    result = await updateEndpointDedup({
      orgId: session.orgId,
      userId: session.userId,
      endpointId,
      dedupConfig: parsed.data,
    });
  } catch (error) {
    logActionError("endpoint.dedup_update_failed", error);
    if (faultCode(error) === "NOT_FOUND") {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    if (faultCode(error) === "VALIDATION_ERROR") {
      return { ok: false, error: (error as { message?: string }).message ?? "Invalid config." };
    }
    return { ok: false, error: "We couldn't update deduplication. Please try again." };
  }
  // Bust the detail page's cached render so a later navigation reflects the saved config. Best-effort — a
  // revalidate throw must NOT flip a committed update into a reported failure (mirrors deleteEndpointAction).
  try {
    revalidatePath(`/endpoints/${endpointId}`);
  } catch (revalidateError) {
    logActionError("endpoint.revalidate_failed", revalidateError);
  }
  return { ok: true, dedupConfig: result.dedupConfig };
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
    // Best-effort cache bust so a subsequent navigation — notably the detail page's delete →
    // router.push("/endpoints") — shows the endpoint gone. Wrapped so a revalidate throw can NEVER flip a
    // committed soft-delete into a reported failure: the contract is "{ok:false} means the mutation failed",
    // and the list-row flow has already dropped the row optimistically regardless.
    try {
      revalidatePath("/endpoints");
    } catch (revalidateError) {
      logActionError("endpoint.revalidate_failed", revalidateError);
    }
    return { ok: true };
  } catch (error) {
    logActionError("endpoint.delete_failed", error);
    if (faultCode(error) === "NOT_FOUND") {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    return { ok: false, error: "We couldn't delete the endpoint. Please try again." };
  }
}
