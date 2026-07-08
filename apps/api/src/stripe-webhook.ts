// Stripe INBOUND webhook receiver. Mirrors the GitHub secret-scanning pre-router branch: raw body BEFORE any
// parse, a size cap, signature verification via the AUDITED Stripe adapter (getAdapterForScheme("stripe") —
// never a hand-rolled HMAC), fail-closed, NO DB touch before the signature verifies. After a verified+deduped
// event, it ACKs 200 immediately and dispatches the state-sync (S4.5b) in ctx.waitUntil, so a slow apply can
// never trip Stripe's own delivery-retry.

import {
  applyCustomerLink,
  applySubscriptionDeleted,
  applySubscriptionUpsert,
  createClient,
  parseCheckoutSession,
  parseSubscriptionObject,
  recordStripeEventOnce,
  resolveOrgId,
  type Sql,
} from "@webhook-co/db";
import { billingEnabled, parseBillingMode, readSecretBinding } from "@webhook-co/shared";
import { getAdapterForScheme } from "@webhook-co/webhooks-spec";

/** Generous cap on a Stripe event body — they are small; anything larger is rejected before parse. */
const MAX_BODY_BYTES = 512 * 1024;

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The Worker bindings the receiver needs (a structural subset of apps/api's Env). All optional so the
 *  endpoint ships DARK — unconfigured/unenabled → a 503 no-op, and Stripe isn't pointed at it until activation. */
export interface StripeWebhookEnv {
  /** BILLING_MODE (off|test|live) — the receiver is dark unless test/live. A committed var. */
  readonly BILLING_MODE?: string;
  /** The Stripe webhook signing secret (whsec_…) — a Secrets Store binding, overlay-injected, never logged. */
  readonly STRIPE_WEBHOOK_SIGNING_SECRET?: SecretsStoreSecret;
  /** webhook_billing Hyperdrive (caching off) for the dedup ledger write. Present only once provisioned. */
  readonly HYPERDRIVE_BILLING?: Hyperdrive;
}

/** A minimally-validated Stripe event envelope (only the fields the receiver + handlers rely on). */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly data: { readonly object: Record<string, unknown> };
}

export type StripeReceiveOutcome =
  | { readonly kind: "ok"; readonly event: StripeEvent }
  /** No signing secret configured — the receiver can't verify, so it fails closed (503). */
  | { readonly kind: "unconfigured" }
  /** No stripe-signature header at all (400). */
  | { readonly kind: "missing_signature" }
  /** The signature/timestamp did not verify (400) — reason is the adapter's failure code (no secret leak). */
  | { readonly kind: "bad_signature"; readonly reason: string }
  /** The verified body isn't a well-formed Stripe event (400). */
  | { readonly kind: "bad_json" }
  /** event.livemode doesn't match the configured mode — a test event must never drive live state (400). */
  | { readonly kind: "livemode_mismatch" };

export interface VerifyStripeArgs {
  readonly rawBody: Uint8Array;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The signing secret; null/empty → unconfigured. */
  readonly signingSecret: string | null;
  /** True when BILLING_MODE=live — the event's livemode must match. */
  readonly billingLive: boolean;
  /** Injected verification clock (skew check) — omit for the real clock. */
  readonly now?: Date;
}

/**
 * Verify a Stripe webhook signature via the audited adapter, then (and only then) parse + shape-check the
 * event and enforce the livemode guard. Pure + fail-closed: it never touches the DB, never throws on a bad
 * input, and never returns a parsed event that didn't verify.
 */
export async function verifyAndParseStripeEvent(
  args: VerifyStripeArgs,
): Promise<StripeReceiveOutcome> {
  const { rawBody, headers, signingSecret, billingLive, now } = args;
  if (!signingSecret) return { kind: "unconfigured" };
  const adapter = getAdapterForScheme("stripe");
  if (!adapter) return { kind: "unconfigured" }; // structurally impossible; defensive

  const hasSig = headers.some(([k]) => k.toLowerCase() === adapter.signatureHeader);
  if (!hasSig) return { kind: "missing_signature" };

  const result = await adapter.verify({ rawBody, headers, secrets: [signingSecret], now });
  if (!result.ok) return { kind: "bad_signature", reason: result.reason.code };

  // Only NOW parse — an unverified body is never handed to JSON.parse for handling.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return { kind: "bad_json" };
  }
  const event = coerceStripeEvent(parsed);
  if (!event) return { kind: "bad_json" };

  // livemode guard: a live event must only ever drive live state and a test event test state. A mismatch is
  // a misconfiguration or an attempt to cross modes — reject rather than mutate the wrong environment.
  if (event.livemode !== billingLive) return { kind: "livemode_mismatch" };
  return { kind: "ok", event };
}

function coerceStripeEvent(v: unknown): StripeEvent | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.type !== "string" ||
    typeof o.created !== "number" ||
    typeof o.livemode !== "boolean"
  ) {
    return null;
  }
  const data = o.data;
  if (typeof data !== "object" || data === null) return null;
  const obj = (data as Record<string, unknown>).object;
  if (typeof obj !== "object" || obj === null) return null;
  return {
    id: o.id,
    type: o.type,
    created: o.created,
    livemode: o.livemode,
    data: { object: obj as Record<string, unknown> },
  };
}

/** Map a non-ok outcome to its HTTP response (verified events are handled by the caller). */
function outcomeToErrorResponse(outcome: Exclude<StripeReceiveOutcome, { kind: "ok" }>): Response {
  switch (outcome.kind) {
    case "unconfigured":
      return text(503, "not configured");
    case "missing_signature":
      return text(400, "missing signature");
    case "bad_signature":
      return text(400, "invalid signature");
    case "bad_json":
      return text(400, "invalid payload");
    case "livemode_mismatch":
      return text(400, "livemode mismatch");
  }
}

/**
 * Handle POST /v1/stripe/webhook. Fail-closed at every step: dark when BILLING_MODE is off (503), can't
 * verify without the signing secret (503), rejects a bad signature before any parse/DB (400). A VERIFIED
 * event is processed SYNCHRONOUSLY then ACKed 200 (the handlers are fast DB writes, well inside Stripe's
 * timeout). Crucially the state APPLY runs BEFORE the dedup is recorded: if the apply throws (a transient
 * DB fault), nothing is marked processed and we return 500 so Stripe REDELIVERS — the appliers are
 * idempotent + watermark-guarded, so a re-apply is safe and no event is ever silently lost. `inject` is a
 * test seam; in prod the work runs on the webhook_billing Hyperdrive (503 if that isn't provisioned yet).
 */
/** Test seam: a fake processor so the handler's gating + status mapping is unit-testable without a DB. */
export interface StripeWebhookTestDeps {
  readonly process: (event: StripeEvent) => Promise<"applied" | "replay">;
}

export async function handleStripeWebhook(
  request: Request,
  env: StripeWebhookEnv,
  inject?: StripeWebhookTestDeps,
): Promise<Response> {
  // Cheap header cap first (reject a lying/oversized declared length before reading the body).
  const declaredLen = request.headers.get("content-length");
  if (declaredLen !== null && Number(declaredLen) > MAX_BODY_BYTES)
    return text(413, "payload too large");

  const mode = parseBillingMode(env.BILLING_MODE ?? null);
  if (!billingEnabled(mode)) return text(503, "billing not enabled"); // dark: off/unset → no-op

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return text(413, "payload too large");

  const signingSecret = env.STRIPE_WEBHOOK_SIGNING_SECRET
    ? await readSecretBinding(env.STRIPE_WEBHOOK_SIGNING_SECRET)
    : null;
  const headers = [...request.headers.entries()] as ReadonlyArray<readonly [string, string]>;
  const outcome = await verifyAndParseStripeEvent({
    rawBody,
    headers,
    signingSecret: signingSecret && signingSecret.length > 0 ? signingSecret : null,
    billingLive: mode === "live",
  });
  if (outcome.kind !== "ok") return outcomeToErrorResponse(outcome);
  const event = outcome.event;

  // Process synchronously; ACK 200 on success (applied OR replay), 500 on failure → Stripe redelivers.
  if (inject) {
    try {
      await inject.process(event);
      return text(200, "ok");
    } catch {
      return text(500, "processing failed");
    }
  }
  if (!env.HYPERDRIVE_BILLING) return text(503, "not configured"); // can't process → fail closed
  const billing = createClient(env.HYPERDRIVE_BILLING.connectionString, { max: 1 });
  try {
    await processStripeEvent(billing, event);
    return text(200, "ok");
  } catch (err) {
    // Nothing was durably marked processed (dedup is recorded only AFTER a successful apply), so a 500 lets
    // Stripe redeliver → the idempotent appliers re-run. Log a sanitized type only (no payload/secret).
    console.log(
      JSON.stringify({
        message: "stripe.webhook.process_failed",
        type: event.type,
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
    return text(500, "processing failed");
  } finally {
    await billing.end();
  }
}

/**
 * Process one verified event: short-circuit a replay we've already recorded, else APPLY the state change
 * (idempotent), then record the dedup marker. Apply-before-record is deliberate — a failure before the
 * marker is written lets Stripe redeliver and the idempotent appliers re-run, so no event is lost. Throws
 * on an apply/DB fault (the handler maps that to 500 for redelivery).
 */
export async function processStripeEvent(
  billing: Sql,
  event: StripeEvent,
): Promise<"applied" | "replay"> {
  const [seen] = await billing<{ x: number }[]>`
    select 1 as x from processed_stripe_events where event_id = ${event.id}`;
  if (seen) return "replay"; // already fully processed
  await applyStripeEvent(billing, event);
  await recordStripeEventOnce(billing, {
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
  });
  return "applied";
}

/** Route a verified event to its state-sync applier. Unhandled types (invoice.*) are a no-op (S4.5b-2).
 *  Throws propagate (→ 500 → Stripe redelivers) — never swallowed, so a failed apply is never lost. */
export async function applyStripeEvent(billing: Sql, event: StripeEvent): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const parsed = parseCheckoutSession(obj);
      if (parsed) await applyCustomerLink(billing, parsed);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = parseSubscriptionObject(obj);
      if (!sub) return;
      const outcome = await applySubscriptionUpsert(billing, sub, event.created);
      if (outcome === "customer_mismatch") {
        // A permanent reject (the subscription's customer isn't this org's) — record + ACK, don't retry.
        console.log(
          JSON.stringify({ message: "stripe.webhook.customer_mismatch", type: event.type }),
        );
      }
      return;
    }
    case "customer.subscription.deleted": {
      const orgId = resolveOrgId(obj);
      if (orgId) await applySubscriptionDeleted(billing, { orgId, eventCreated: event.created });
      return;
    }
    default:
      return; // unhandled type — recorded + ACKed, no state change
  }
}
