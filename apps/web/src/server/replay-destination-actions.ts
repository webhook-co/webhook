"use server";

import { revalidatePath } from "next/cache";

import { logActionError } from "./action-log";
import { isUuid } from "./endpoints";
import {
  createDestination,
  enableDestination,
  InvalidDestinationUrlError,
  removeDestination,
  rotateDestinationSecret,
  SealerUnavailableError,
  setDestinationOrdered,
} from "./replay-destination-mutations";
import { loadSigningSecrets, toDestinationItem, type DestinationItem } from "./replay-destinations";
import { destinationUrlError } from "../lib/destination-copy";
import { requireOrgAccess } from "./org-access";

// The replay-destinations mutation actions — the session/CSRF boundary (Next same-origin) + input guard +
// error taxonomy over the mutations seam. Authz is the session + RLS-org-pinning (any org member may manage
// the org's allowlist — matching the endpoints/credentials dashboards). Secrets (`whsec_`) are returned
// ONCE, only as an action result — never SSR'd, persisted, or logged (logActionError takes the error, never
// the input). The allowlist is a trust surface, so a create URL is structurally SSRF-checked in the seam
// before any write; here we translate its refusal reason into honest, plain-language copy.

// Mirror the contract input bounds so the dashboard accepts exactly what api/cli/mcp accept.
const MAX_URL_LEN = 2048;
const MAX_LABEL_LEN = 200;

export type CreateDestinationResult =
  | { readonly ok: true; readonly destination: DestinationItem; readonly signingSecret?: string }
  | { readonly ok: false; readonly error: string };

export type DestinationMutationResult =
  | { readonly ok: true; readonly destination: DestinationItem }
  | { readonly ok: false; readonly error: string };

export type DestinationActionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export type RotateSecretResult =
  | { readonly ok: true; readonly signingSecret: string }
  | { readonly ok: false; readonly error: string };

export type ListSecretsResult =
  | {
      readonly ok: true;
      readonly items: readonly { id: string; status: string; createdAt: Date }[];
    }
  | { readonly ok: false; readonly error: string };

/** `slug` is the CANONICAL slug off OrgAccess — an invalidation aimed at a path that doesn't exist (a
 *  mis-cased or retired segment) is a silent no-op, and the list would go stale until a hard reload. */
function revalidate(slug: string): void {
  try {
    revalidatePath(`/org/${slug}/destinations`);
  } catch (error) {
    logActionError("destinations.revalidate_failed", error);
  }
}

/**
 * Register a replay destination. The URL is structurally SSRF-checked in the seam (fail-closed before any
 * write); a refusal maps to honest, plain-language copy. On a fresh create the one-time signing secret is
 * returned ONCE as this result; an idempotent re-add of a live URL returns the row with no secret.
 */
export async function createDestinationAction(
  slug: string,
  input: {
    url: string;
    label?: string;
  },
): Promise<CreateDestinationResult> {
  // No subPath: an action doesn't render, so there is nothing to redirect.
  const session = await requireOrgAccess(slug);
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  if (!url) return { ok: false, error: "Enter a destination URL." };
  if (url.length > MAX_URL_LEN) return { ok: false, error: "That URL is too long." };
  const labelRaw = typeof input?.label === "string" ? input.label.trim() : "";
  if (labelRaw.length > MAX_LABEL_LEN) {
    return { ok: false, error: `Keep the label under ${MAX_LABEL_LEN} characters.` };
  }

  try {
    const created = await createDestination({
      orgId: session.orgId,
      url,
      label: labelRaw || null,
      actor: session.userId,
    });
    revalidate(session.slug);
    return {
      ok: true,
      destination: toDestinationItem(created.record),
      signingSecret: created.signingSecret,
    };
  } catch (error) {
    logActionError("destinations.create_failed", error);
    if (error instanceof InvalidDestinationUrlError) {
      return { ok: false, error: destinationUrlError(error.reason) };
    }
    if (error instanceof SealerUnavailableError) {
      return { ok: false, error: "Signing isn't available right now. Please try again shortly." };
    }
    return { ok: false, error: "We couldn't register the destination. Please try again." };
  }
}

/** Soft-delete a destination — it stops being a delivery target immediately; open deliveries are cancelled. */
export async function deleteDestinationAction(
  slug: string,
  destinationId: string,
): Promise<DestinationActionResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  try {
    const removed = await removeDestination({
      orgId: session.orgId,
      destinationId,
      actor: session.userId,
    });
    if (!removed) return { ok: false, error: "That destination no longer exists." };
    revalidate(session.slug);
    return { ok: true };
  } catch (error) {
    logActionError("destinations.delete_failed", error);
    return { ok: false, error: "We couldn't remove the destination. Please try again." };
  }
}

/** Re-enable an auto-disabled destination so it becomes a delivery target again. */
export async function enableDestinationAction(
  slug: string,
  destinationId: string,
): Promise<DestinationMutationResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  try {
    const rec = await enableDestination({
      orgId: session.orgId,
      destinationId,
      actor: session.userId,
    });
    if (!rec) return { ok: false, error: "That destination no longer exists." };
    revalidate(session.slug);
    return { ok: true, destination: toDestinationItem(rec) };
  } catch (error) {
    logActionError("destinations.enable_failed", error);
    return { ok: false, error: "We couldn't enable the destination. Please try again." };
  }
}

/** Toggle a destination's strict-FIFO (`ordered`) delivery mode. */
export async function setDestinationOrderedAction(
  slug: string,
  destinationId: string,
  ordered: boolean,
): Promise<DestinationMutationResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  try {
    const rec = await setDestinationOrdered({
      orgId: session.orgId,
      destinationId,
      ordered: ordered === true,
      actor: session.userId,
    });
    if (!rec) return { ok: false, error: "That destination no longer exists." };
    revalidate(session.slug);
    return { ok: true, destination: toDestinationItem(rec) };
  } catch (error) {
    logActionError("destinations.set_ordered_failed", error);
    return { ok: false, error: "We couldn't update the destination. Please try again." };
  }
}

/**
 * Rotate a destination's signing secret — the previous active key retires (still honored for verification
 * during overlap), a fresh one is minted. Returns the NEW one-time `whsec_` — shown once, never re-fetchable.
 */
export async function rotateDestinationSecretAction(
  slug: string,
  destinationId: string,
): Promise<RotateSecretResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  try {
    const rotated = await rotateDestinationSecret({
      orgId: session.orgId,
      destinationId,
      actor: session.userId,
    });
    if (!rotated) return { ok: false, error: "That destination no longer exists." };
    return { ok: true, signingSecret: rotated.secret };
  } catch (error) {
    logActionError("destinations.rotate_failed", error);
    if (error instanceof SealerUnavailableError) {
      return { ok: false, error: "Signing isn't available right now. Please try again shortly." };
    }
    return { ok: false, error: "We couldn't rotate the signing secret. Please try again." };
  }
}

/** List a destination's signing-secret history as metadata only (id/status/createdAt) — never the plaintext. */
export async function listDestinationSecretsAction(
  slug: string,
  destinationId: string,
): Promise<ListSecretsResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  const res = await loadSigningSecrets(session.orgId, destinationId);
  if (res.status === "not_found") return { ok: false, error: "That destination no longer exists." };
  if (res.status !== "ok") return { ok: false, error: "We couldn't load the signing keys." };
  return { ok: true, items: res.items };
}
