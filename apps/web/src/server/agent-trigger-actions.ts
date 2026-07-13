"use server";

import { CapabilityFault } from "@webhook-co/contract";
import { revalidatePath } from "next/cache";

import { logActionError } from "./action-log";
import {
  createTrigger,
  revokeTrigger,
  TriggerEndpointNotFoundError,
} from "./agent-trigger-mutations";
import { toTriggerItem, type TriggerItem } from "./agent-triggers";
import { isUuid } from "./endpoints";
import { requireOrgAccess } from "./org-access";

// The agent-trigger mutation actions — the session/CSRF boundary (Next same-origin) + input guard + error
// taxonomy over the mutations seam. Authz is the session + RLS-org-pinning (any org member may manage the
// org's triggers, matching the endpoints/destinations dashboards). A trigger creates no egress and holds no
// secret, so there's nothing sensitive to reveal here — errors are scrubbed via logActionError (never the
// input). Mirrors the contract input bounds so the dashboard accepts exactly what api/cli/mcp accept.
const MAX_NAME_LEN = 100;

export type CreateTriggerResult =
  | { readonly ok: true; readonly trigger: TriggerItem }
  | { readonly ok: false; readonly error: string };

export type TriggerActionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/** `slug` is the CANONICAL slug off OrgAccess — the raw URL segment may be mis-cased or retired, and an
 *  invalidation aimed at a path that doesn't exist is a silent no-op. */
function revalidate(slug: string): void {
  try {
    revalidatePath(`/org/${slug}/triggers`);
  } catch (error) {
    logActionError("triggers.revalidate_failed", error);
  }
}

/**
 * Register an agent trigger for an endpoint. The endpoint id must be a uuid the caller's org owns; a missing /
 * soft-deleted / cross-org endpoint maps to a "no longer exists" message (never leaking existence), and the
 * per-org active-trigger cap maps to friendly copy.
 */
export async function createTriggerAction(
  slug: string,
  input: {
    endpointId: string;
    name?: string;
  },
): Promise<CreateTriggerResult> {
  // No subPath: an action doesn't render, so there is nothing to redirect — it resolves a renamed slug
  // straight through and acts on the right org (a form posted seconds before a rename must still work).
  const session = await requireOrgAccess(slug);
  const endpointId = typeof input?.endpointId === "string" ? input.endpointId : "";
  if (!isUuid(endpointId)) return { ok: false, error: "Choose an endpoint." };
  const nameRaw = typeof input?.name === "string" ? input.name.trim() : "";
  if (nameRaw.length > MAX_NAME_LEN) {
    return { ok: false, error: `Keep the label under ${MAX_NAME_LEN} characters.` };
  }

  try {
    const created = await createTrigger({
      orgId: session.orgId,
      endpointId,
      name: nameRaw || null,
      actor: session.userId,
    });
    revalidate(session.slug);
    return { ok: true, trigger: toTriggerItem(created) };
  } catch (error) {
    logActionError("triggers.create_failed", error);
    if (error instanceof TriggerEndpointNotFoundError) {
      return { ok: false, error: "That endpoint no longer exists." };
    }
    if (error instanceof CapabilityFault && error.code === "RATE_LIMITED") {
      return {
        ok: false,
        error: "You've reached the active-trigger limit. Revoke an unused trigger and try again.",
      };
    }
    return { ok: false, error: "We couldn't create the trigger. Please try again." };
  }
}

/** Revoke a trigger — it stops waking its agent immediately. Idempotent; an unknown id reads as "no longer exists". */
export async function revokeTriggerAction(
  slug: string,
  triggerId: string,
): Promise<TriggerActionResult> {
  const session = await requireOrgAccess(slug);
  if (!isUuid(triggerId)) return { ok: false, error: "That trigger no longer exists." };
  try {
    const revoked = await revokeTrigger({
      orgId: session.orgId,
      triggerId,
      actor: session.userId,
    });
    if (!revoked) return { ok: false, error: "That trigger no longer exists." };
    revalidate(session.slug);
    return { ok: true };
  } catch (error) {
    logActionError("triggers.revoke_failed", error);
    return { ok: false, error: "We couldn't revoke the trigger. Please try again." };
  }
}
