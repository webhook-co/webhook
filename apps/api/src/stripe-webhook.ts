// Stripe INBOUND webhook receiver. Mirrors the GitHub secret-scanning pre-router branch: raw body BEFORE any
// parse, a size cap, signature verification via the AUDITED Stripe adapter (getAdapterForScheme("stripe") —
// never a hand-rolled HMAC), fail-closed, NO DB touch before the signature verifies. A verified event is
// processed SYNCHRONOUSLY (the appliers + the S4.5 tail-flush are fast, well inside Stripe's timeout) then
// ACKed: 200 on success/replay, 500 on a transient fault so Stripe redelivers (apply-before-record keeps it
// idempotent). The invoice.created tail-flush is best-effort — it never throws, so it can't turn into a 500.

import {
  applyCustomerLink,
  applySubscriptionDeleted,
  applySubscriptionUpsert,
  createClient,
  flushOrgTail,
  type MeterReportSink,
  parseCheckoutSession,
  parseSubscriptionObject,
  recordStripeEventOnce,
  resolveOrgId,
  safeErr,
  type Sql,
} from "@webhook-co/db";
import {
  billingEnabled,
  makeStripeClient,
  parseBillingMode,
  readSecretBinding,
  stripeKeyMatchesMode,
  USAGE_SETTLE_DAYS,
} from "@webhook-co/shared";
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
  /** The Stripe SECRET key (sk_…) — needed by the tail-flush to REPORT meter usage outbound (not just verify
   *  inbound). A Secrets Store binding; present only once the flush is provisioned. Dark without it. */
  readonly STRIPE_SECRET_KEY?: SecretsStoreSecret;
  /** The Stripe Billing Meter event_name (config) the tail-flush reports against. */
  readonly STRIPE_METER_EVENT_NAME?: string;
  /** webhook_app Hyperdrive — the tail-flush finalizes usage + drains the outbox per-org under RLS here. */
  readonly HYPERDRIVE_TENANT?: Hyperdrive;
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
/** What the tail-flush needs from a signature-verified `invoice.created`, or null if this invoice isn't a
 *  subscription cycle we flush. org_id rides `subscription_details.metadata` (the signed value we set on the
 *  subscription at Checkout; `lines[0].metadata` is the fallback) — the event is already verified, so it is
 *  trusted, exactly like the subscription appliers. The floor is utcDay(period_start), scoping the produce to
 *  THIS period's tail (never re-touching a prior period, and no DB read for the subscription's created_at). */
export interface InvoiceFlushTarget {
  readonly orgId: string;
  readonly floorDay: string;
  readonly periodEndMs: number;
}

export function parseInvoiceForFlush(invoice: Record<string, unknown>): InvoiceFlushTarget | null {
  // Stripe 'Basil' (API 2025-03-31+) RELOCATED `subscription` + its `subscription_details` (incl. the
  // metadata WE set) from the invoice top level to `invoice.parent.subscription_details`. We pin 2024-06-20
  // (top-level), but read BOTH shapes so a future version bump — or an endpoint on a newer version — can't
  // silently null every flush (mirrors billing-sync.ts's dual-shape handling for subscriptions).
  const parentSub = (
    invoice.parent as
      | { subscription_details?: { subscription?: unknown; metadata?: Record<string, unknown> } }
      | undefined
  )?.subscription_details;
  const topSubMeta = (
    invoice.subscription_details as { metadata?: Record<string, unknown> } | undefined
  )?.metadata;
  const subMeta = topSubMeta ?? parentSub?.metadata;
  const lineMeta = (
    invoice.lines as { data?: Array<{ metadata?: Record<string, unknown> }> } | undefined
  )?.data?.[0]?.metadata;
  const fromSub = typeof subMeta?.org_id === "string" ? subMeta.org_id : "";
  const fromLine = typeof lineMeta?.org_id === "string" ? lineMeta.org_id : "";
  const orgId = fromSub || fromLine;
  const hasSubscription =
    typeof invoice.subscription === "string" || typeof parentSub?.subscription === "string";
  const {
    billing_reason: billingReason,
    period_start: periodStart,
    period_end: periodEnd,
  } = invoice;
  // Flush ONLY on a clean period-close RENEWAL (`subscription_cycle`), where the invoice-level period IS the
  // metered cycle. The 0-length first invoice (`subscription_create`) and proration/update invoices
  // (`subscription_update` — invoice period ≠ the metered cycle) are skipped; their usage is captured by the
  // next `subscription_cycle` invoice. period_start/period_end stay top-level in every API version.
  if (
    !orgId ||
    !hasSubscription ||
    billingReason !== "subscription_cycle" ||
    typeof periodStart !== "number" ||
    typeof periodEnd !== "number" ||
    periodEnd <= periodStart
  ) {
    return null;
  }
  return {
    orgId,
    floorDay: new Date(periodStart * 1000).toISOString().slice(0, 10),
    periodEndMs: periodEnd * 1000,
  };
}

/** Runs the tail-flush for a verified `invoice.created`. BEST-EFFORT: opens a per-event webhook_app
 *  connection, flushes, and NEVER throws to the caller — a flush fault must not 500 the webhook (Stripe's
 *  redelivery can land past the short draft grace, and the WS1 transport reconciler already alarms on any
 *  residual). Built only when the flush is fully configured + mode-matched; otherwise the branch is dark.
 *  Returns `true` when the event is safe to DEDUP (nothing to flush, or the whole tail landed), `false` when
 *  it should stay REPLAYABLE (the flush threw or a send failed) so a later manual Stripe replay can retry. */
export interface TailFlushRunner {
  onInvoiceCreated(invoice: Record<string, unknown>): Promise<boolean>;
}

export function makeTailFlushRunner(cfg: {
  readonly tenantConnectionString: string;
  readonly stripe: MeterReportSink;
  readonly eventName: string;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}): TailFlushRunner {
  return {
    async onInvoiceCreated(invoice) {
      const target = parseInvoiceForFlush(invoice);
      if (!target) return true; // genuinely not a flushable cycle → dedup is safe
      const app = createClient(cfg.tenantConnectionString, { max: 1 });
      try {
        const res = await flushOrgTail(
          { app, stripe: cfg.stripe, eventName: cfg.eventName, log: cfg.log },
          {
            orgId: target.orgId,
            floorDay: target.floorDay,
            periodEndMs: target.periodEndMs,
            settleDays: USAGE_SETTLE_DAYS,
          },
        );
        // A residual send failure (or a skipped drain awaiting the customer link) must NOT be deduped as
        // done — leave the event replayable so a retry after the WS1 reconciler alarms can land the tail.
        return res.failed === 0 && res.skippedNoCustomer === 0;
      } catch (err) {
        cfg.log?.("metering.tail_flush.error", { orgId: target.orgId, ...safeErr(err) });
        return false; // threw → replayable
      } finally {
        await app.end();
      }
    },
  };
}

/**
 * Build the tail-flush runner from the Worker env, or `undefined` (dark) if it isn't fully configured. The
 * flush is a DISTINCT capability from inbound verification: it REPORTS meter usage outbound, so it needs the
 * Stripe SECRET key + the meter event_name + a webhook_app (HYPERDRIVE_TENANT) connection — none required to
 * merely verify + sync subscriptions. Fail-closed + mode-bound: a key/mode mismatch (a live key under
 * BILLING_MODE=test, or vice-versa) returns `undefined` rather than building a client that could report to
 * the wrong account, mirroring makeStripeClient's own guard without throwing inside the webhook.
 */
async function buildTailFlushRunner(
  env: StripeWebhookEnv,
  mode: ReturnType<typeof parseBillingMode>,
): Promise<TailFlushRunner | undefined> {
  const eventName = env.STRIPE_METER_EVENT_NAME?.trim();
  const secretKey = env.STRIPE_SECRET_KEY ? await readSecretBinding(env.STRIPE_SECRET_KEY) : null;
  if (!eventName || !secretKey || secretKey.length === 0 || !env.HYPERDRIVE_TENANT)
    return undefined;
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    console.log(JSON.stringify({ message: "metering.tail_flush.key_mode_mismatch", mode }));
    return undefined;
  }
  const stripe = makeStripeClient({ mode, secretKey });
  return makeTailFlushRunner({
    tenantConnectionString: env.HYPERDRIVE_TENANT.connectionString,
    stripe,
    eventName,
    log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
  });
}

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
  // Build the flush runner ONLY for the one event that consumes it — this reads a Secrets Store binding, so
  // gating on the type keeps every other webhook (and every replay) off that round-trip.
  const flush =
    event.type === "invoice.created" ? await buildTailFlushRunner(env, mode) : undefined;
  try {
    await processStripeEvent(billing, event, flush);
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
  flush?: TailFlushRunner,
): Promise<"applied" | "replay" | "rejected"> {
  const [seen] = await billing<{ x: number }[]>`
    select 1 as x from processed_stripe_events where event_id = ${event.id}`;
  if (seen) return "replay"; // already fully processed
  const outcome = await applyStripeEvent(billing, event, flush);
  // Record the dedup marker ONLY for an applied event. A "rejected" event (a customer/org identity mismatch)
  // is deliberately NOT recorded: it is ACKed 200 (no Stripe retry-storm for a condition retries can't fix)
  // but left out of the ledger so that, if the reject was a data anomaly we later correct, a manual Stripe
  // replay can reprocess it — a reject is never permanently swallowed.
  if (outcome === "applied") {
    await recordStripeEventOnce(billing, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });
    return "applied";
  }
  return "rejected";
}

/** Route a verified event to its state-sync applier. Unhandled types (invoice.*) are a no-op (S4.5b-2).
 *  Returns "rejected" for a business reject that must NOT be deduped (see processStripeEvent); "applied"
 *  otherwise. Throws propagate (→ 500 → Stripe redelivers) — a transient fault is never swallowed. */
export async function applyStripeEvent(
  billing: Sql,
  event: StripeEvent,
  flush?: TailFlushRunner,
): Promise<"applied" | "rejected"> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const parsed = parseCheckoutSession(obj);
      if (parsed) await applyCustomerLink(billing, parsed);
      return "applied";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = parseSubscriptionObject(obj);
      if (!sub) return "applied"; // unparseable → recorded as seen (no reprocessing helps a bad shape)
      const outcome = await applySubscriptionUpsert(billing, sub, event.created);
      if (outcome === "customer_mismatch") {
        // The subscription's customer isn't this org's — a bug/attack. Log + reject (NOT deduped, so a
        // later data fix + replay can reprocess). Never mutate on a mismatch.
        console.log(
          JSON.stringify({ message: "stripe.webhook.customer_mismatch", type: event.type }),
        );
        return "rejected";
      }
      return "applied";
    }
    case "customer.subscription.deleted": {
      const orgId = resolveOrgId(obj);
      if (orgId) await applySubscriptionDeleted(billing, { orgId, eventCreated: event.created });
      return "applied";
    }
    case "invoice.created": {
      // A period is closing: FLUSH the org's complete tail days to Stripe while THIS invoice is still a
      // draft (WS2 proved usage reported before finalization lands on the invoice, and usage reported after
      // is dropped). Best-effort + idempotent — the runner never throws, so it never blocks the ACK.
      //
      // Dedup only when the flush is genuinely DONE. When it is DARK (unprovisioned) or a send failed, return
      // "rejected": still ACK 200 (no Stripe retry storm), but DON'T write the dedup marker, so a later manual
      // replay — once provisioned, or after the WS1 reconciler alarms — reprocesses and lands the tail. If we
      // recorded these as "applied", the tail would be permanently lost (Stripe never redelivers a 200'd event).
      if (!flush) return "rejected";
      return (await flush.onInvoiceCreated(obj)) ? "applied" : "rejected";
    }
    default:
      return "applied"; // unhandled type — recorded + ACKed, no state change
  }
}
