"use server";

import type { DeliveryAttempt } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { isUuid } from "./endpoints";
import {
  DispatcherUnavailableError,
  replayToDestination,
  ReplayConflictError,
  ReplayNotFoundError,
  ReplayPausedError,
  ReplayUnverifiedError,
} from "./replay-mutations";
import { verifySession } from "./session";

// The replay-to-destination action — the session/CSRF boundary (Next same-origin) + input guard + error
// taxonomy over the replay orchestration. Authz is the session + RLS-org-pinning (any org member may replay
// the org's events). A replay RESOLVES to a DeliveryAttempt for delivered / failed / blocked alike — those
// are real outcomes, not thrown errors — so the caller renders the returned status honestly; only a genuine
// fault (event/destination gone, engine binding absent, unexpected) is `{ok:false}`.

/** The delivery attempt returned to the browser — the internal orgId pointer stripped. */
export type ReplayAttemptView = Omit<DeliveryAttempt, "orgId">;

export type ReplayResult =
  | { readonly ok: true; readonly attempt: ReplayAttemptView }
  | { readonly ok: false; readonly error: string };

function toView(a: DeliveryAttempt): ReplayAttemptView {
  const { orgId: _orgId, ...rest } = a;
  return rest;
}

/**
 * Replay a captured event to a registered destination via the engine (the only guarded egress). Returns the
 * resulting `DeliveryAttempt` (status rendered honestly by the caller). A non-uuid id is treated as gone (no
 * db 22P02); a missing engine binding fails closed.
 */
export async function replayToDestinationAction(
  eventId: string,
  destinationId: string,
): Promise<ReplayResult> {
  const session = await verifySession();
  if (!isUuid(eventId)) return { ok: false, error: "That event no longer exists." };
  if (!isUuid(destinationId)) return { ok: false, error: "That destination no longer exists." };
  try {
    const attempt = await replayToDestination({
      orgId: session.orgId,
      eventId,
      destinationId,
    });
    return { ok: true, attempt: toView(attempt) };
  } catch (error) {
    logActionError("replay.to_destination_failed", error);
    if (error instanceof ReplayNotFoundError) {
      return { ok: false, error: "That event or destination no longer exists." };
    }
    if (error instanceof DispatcherUnavailableError) {
      return { ok: false, error: "Replay is unavailable right now. Please try again shortly." };
    }
    if (error instanceof ReplayUnverifiedError) {
      // A `failed`-verification event can't be replayed (it would re-sign forged content) — ADR-0103.
      return {
        ok: false,
        error: "This event's signature was rejected, so it can't be replayed to a destination.",
      };
    }
    if (error instanceof ReplayPausedError) {
      // The org is paused at its event limit (S4) — a replay would mint a billable delivery past the cap.
      return {
        ok: false,
        error: "You're paused at your event limit. Resume or raise the limit to replay.",
      };
    }
    if (error instanceof ReplayConflictError) {
      // A near-impossible key collision — ask the user to retry (a fresh key is minted next time).
      return { ok: false, error: "Couldn't replay this event just now. Please try again." };
    }
    return { ok: false, error: "We couldn't replay the event. Please try again." };
  }
}
