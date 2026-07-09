// The notification-drain cron glue (S3 Slice 3 PR3c-3b). A scheduled() trigger drains pending
// notification_intents across ALL orgs (written by the engine when a destination auto-disables — the engine
// can't send mail), emails the org owner, and marks each intent sent. It connects as the least-privilege
// webhook_notifier role over HYPERDRIVE_NOTIFIER (role-targeted policies: read pending intents + owner email,
// flip pending→sent only) and sends via Resend from the verified mail.webhook.co sender — the same posture as
// the magic-link sender.
//
// CLAIM-THEN-SEND (single-flight): each intent is claimed (markNotificationSent) BEFORE the email is sent, so
// under two overlapping cron passes exactly one claims + sends → at-most-once. A send failure after a claim is
// logged (`notify.send_failed`) and NOT retried — the destination is already disabled + visible in the
// dashboard, so a missed courtesy email is preferable to the double-send an un-claim/retry would risk. worker.ts
// (tsc-excluded for its generated-handler import) calls runNotificationDrain from a thin scheduled(), mirroring
// runAuthExpirySweep — so the real logic stays here, type-checked + tested. Errors are logged, never thrown.

import {
  createClient,
  listPendingNotifications,
  markNotificationSent,
  type PendingNotification,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";

import { renderApiKeyRevokedEmail, type ApiKeyRevokedContext } from "./api-key-revoked-email";
import {
  renderDestinationDisabledEmail,
  type DestinationDisabledContext,
} from "./destination-disabled-email";
import { readNotifyEnv, type NotifyEnv } from "./env";
import { NOTIFICATIONS_FROM } from "./urls";
import { renderUsageThresholdEmail, type UsageThresholdContext } from "./usage-threshold-email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** The common shape every notification renderer produces (subject + HTML + text). Every family
 *  (destination_disabled, usage_threshold, api_key_revoked) emits this, so the sender is kind-agnostic. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Render the email for a pending intent by its `kind`, or null if it isn't sendable (an unknown kind, or a
 * context-requiring kind with no snapshot). `p.context` is the discriminated jsonb union; each case casts to
 * its family's shape (structurally identical to the db type). destination_disabled degrades gracefully on a
 * null context; usage_threshold and api_key_revoked REQUIRE their snapshot (no usable email without the
 * numbers / without knowing which key died).
 */
function renderIntent(p: PendingNotification): RenderedEmail | null {
  if (p.kind === "destination_disabled") {
    return renderDestinationDisabledEmail(
      (p.context as DestinationDisabledContext | null) ?? null,
      p.createdAt,
    );
  }
  if (p.kind === "usage_threshold") {
    if (!p.context) return null;
    return renderUsageThresholdEmail(p.context as UsageThresholdContext);
  }
  if (p.kind === "api_key_revoked") {
    // REQUIRES its snapshot: without the key's name/start the owner can't tell which key we killed.
    if (!p.context) return null;
    return renderApiKeyRevokedEmail(p.context as ApiKeyRevokedContext);
  }
  return null;
}

export interface NotificationDrainDeps {
  /** Read pending intents (as webhook_notifier, cross-org). */
  listPending: () => Promise<PendingNotification[]>;
  /** Claim one intent (flip pending→sent, single-flight). Returns whether THIS call won the claim. */
  claim: (intentId: string) => Promise<boolean>;
  /** Send the rendered email to ONE recipient (per-owner — never a shared To header). Kind-agnostic. */
  send: (to: string, email: RenderedEmail) => Promise<void>;
  /** Optional structured logger — only intent ids + counts (no PII). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface NotificationDrainResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  /** Claimed but not sendable (unknown kind, no context, or no resolvable owner) — cleared, not emailed. */
  readonly skipped: number;
}

/** Drain pending notifications: claim each (single-flight), then send the owner email for the ones we win. */
export async function drainNotifications(
  deps: NotificationDrainDeps,
): Promise<NotificationDrainResult> {
  const pending = await deps.listPending();
  let claimed = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const p of pending) {
    // CLAIM first: if another pass already claimed it, skip (don't double-send).
    if (!(await deps.claim(p.intentId))) continue;
    claimed++;

    // Sendable = a known-kind intent we can render (renderIntent) AND at least one recipient. Anything else
    // — an unknown kind, an unrenderable usage_threshold (no context), or an ownerless org — is claimed to
    // clear it, then skipped (never left pending to retry-loop forever).
    //
    // renderIntent is TOTAL from the drain's point of view: the intent is ALREADY claimed by now, so a render
    // that throws (a malformed jsonb context, say) would both lose this owner's alert AND abort the loop,
    // silently dropping every still-pending intent behind it — including outage and usage alerts for other
    // orgs. A throw is therefore caught and treated exactly like an unrenderable intent: claimed, logged, skipped.
    let email: RenderedEmail | null;
    try {
      email = renderIntent(p);
    } catch (err) {
      email = null;
      deps.log?.("notify.render_failed", {
        intentId: p.intentId,
        kind: p.kind,
        error: String(err),
      });
    }
    if (email === null || p.ownerEmails.length === 0) {
      skipped++;
      deps.log?.("notify.claimed_no_send", {
        intentId: p.intentId,
        kind: p.kind,
        recipients: p.ownerEmails.length,
      });
      continue;
    }
    // ONE email per owner — never place multiple owners in a shared To header (that would leak each owner's
    // address to the others). Already claimed → a per-owner send failure is logged, not retried (at-most-once).
    for (const owner of p.ownerEmails) {
      try {
        await deps.send(owner, email);
        sent++;
      } catch (err) {
        failed++;
        deps.log?.("notify.send_failed", { intentId: p.intentId, error: String(err) });
      }
    }
  }

  deps.log?.("notify.drain_done", { claimed, sent, failed, skipped });
  return { claimed, sent, failed, skipped };
}

/** Send one notification email to ONE recipient via the Resend REST API (no SDK; the API key never appears in
 *  an error message). Resolves on a 2xx; throws on any other status so the drain logs + counts the failure. */
async function sendViaResend(
  apiKey: string,
  to: string,
  email: RenderedEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIFICATIONS_FROM,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!res.ok) throw new Error(`notification email send failed with status ${res.status}`);
}

/**
 * Run one notification drain. Validates the env fail-closed, opens a webhook_notifier-scoped client over
 * HYPERDRIVE_NOTIFIER, resolves the Resend key, drains, and always closes the client. Any setup failure is
 * logged (`auth.notify.cron.error`, message only) and swallowed so the scheduled handler never rejects.
 * Returns the drain result, or null on a setup failure.
 */
export async function runNotificationDrain(
  env: Record<string, unknown>,
): Promise<NotificationDrainResult | null> {
  let validated: NotifyEnv;
  let apiKey: string;
  try {
    validated = readNotifyEnv(env);
    apiKey = await readSecretBinding(validated.RESEND_API_KEY);
    if (!apiKey) throw new Error("notify env: RESEND_API_KEY resolved empty");
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "auth.notify.cron.error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }

  const sql = createClient(validated.HYPERDRIVE_NOTIFIER.connectionString, { max: 1 });
  try {
    const result = await drainNotifications({
      listPending: () => listPendingNotifications(sql),
      claim: (intentId) => markNotificationSent(sql, intentId),
      send: (to, email) => sendViaResend(apiKey, to, email),
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
    console.log(JSON.stringify({ message: "auth.notify.cron", ...result }));
    return result;
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "auth.notify.cron.error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  } finally {
    await sql.end().catch((error: unknown) =>
      console.log(
        JSON.stringify({
          message: "auth.notify.cron.pool_close_error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
}
