// The OUTBOUND Stripe API client (S4.4b) — the counterpart to the audited INBOUND verifier
// (packages/webhooks-spec stripe adapter). A thin, dependency-free fetch wrapper over Stripe's REST API:
// form-urlencoded bodies (Stripe's bracket notation for nested params), Bearer sk_ auth, an optional
// Idempotency-Key, and a pinned Stripe-Version. NO Stripe SDK (Workers-friendly, auditable, no supply
// chain). The secret key is passed in (read from a Secrets Store binding by the caller) and NEVER logged.
// The client is MODE-BOUND: `mode` is required and asserted against the key's prefix at construction, so a
// live key can never be used by a test-mode deploy (real charges) and a test key can never be used by a live
// one (no money taken). See stripeKeyMatchesMode.

import { stripeKeyMatchesMode, type BillingMode, type SubscriptionItemRef } from "./billing";

/** Pinned Stripe API version — supports Billing Meters (the metered-overage model). Bump deliberately. */
export const STRIPE_API_VERSION = "2024-06-20";
const DEFAULT_API_BASE = "https://api.stripe.com";

/** A structured Stripe API error — carries the HTTP status + Stripe's error type/code, never the secret. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly stripeType?: string,
    readonly stripeCode?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

// A JSON-ish param value Stripe accepts. Nested objects/arrays are flattened to bracket notation
// (metadata[org_id]=…, line_items[0][price]=…). undefined/null values are omitted.
type StripeParam = string | number | boolean | null | undefined | StripeParams | StripeParam[];
export interface StripeParams {
  readonly [key: string]: StripeParam;
}

/**
 * Encode params in Stripe's application/x-www-form-urlencoded bracket notation. Recurses into objects and
 * arrays (`a[b][0][c]=v`), stringifies scalars, and DROPS undefined/null (Stripe treats an absent key as
 * unset — sending "null" would be the literal string). Deterministic key order (insertion) for testability.
 */
export function stripeFormEncode(params: StripeParams): string {
  const pairs: Array<[string, string]> = [];
  const walk = (value: StripeParam, prefix: string): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${prefix}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}[${k}]` : k);
    } else {
      pairs.push([prefix, String(value)]);
    }
  };
  walk(params, "");
  return new URLSearchParams(pairs).toString();
}

export interface StripeClientOptions {
  /** The Stripe secret key (sk_test_… or sk_live_…). Read from a Secrets Store binding; NEVER logged. */
  readonly secretKey: string;
  /**
   * The billing mode this key must belong to. REQUIRED, and asserted below — a guard that lives only at the
   * call sites is one a future caller can skip. A live key in test mode charges real cards; a test key in
   * live mode takes no money. Both are silent, so we refuse to construct the client at all.
   */
  readonly mode: BillingMode;
  /** Override the API base (for a mock server in tests). Defaults to https://api.stripe.com. */
  readonly apiBase?: string;
  /** Injected fetch (Workers global by default) so tests can supply a fake without network. */
  readonly fetchImpl?: typeof fetch;
}

/** A hosted-session result (Checkout / Billing Portal) — the id + the URL the browser is redirected to. */
export interface StripeHostedSession {
  readonly id: string;
  readonly url: string;
}

/** A subscription as the plan switch needs it: its id, raw Stripe status, and its price items. */
export interface StripeSubscription {
  readonly id: string;
  readonly status: string;
  readonly items: readonly SubscriptionItemRef[];
  /** The invoice for the CURRENT period — paid or not. The refund anchors to this rather than searching for
   *  the latest *paid* invoice, which on a `past_due` sub is the previous (already consumed) period's. */
  readonly latestInvoiceId: string | null;
}

/** One metered-usage report to a Stripe Billing Meter (the metered-overage counter). */
export interface ReportMeterEventArgs {
  /** The meter's `event_name` (config, e.g. "webhook_events") — which meter this usage counts against. */
  readonly eventName: string;
  /** The org's Stripe customer id (billing_customers) — Stripe attributes the usage to this customer. */
  readonly customer: string;
  /** The usage value for the period (an event count for a UTC day). Sent as a string, per Stripe. */
  readonly value: number;
  /** Stripe's native dedup key = `{org}:{day}`. ALSO the HTTP Idempotency-Key — a re-report is a no-op. */
  readonly identifier: string;
  /** Unix SECONDS placing the event in a billing period. Omit to let Stripe use ingest time. */
  readonly timestamp?: number;
}

/** Stripe's echo of an accepted meter event — carries the `identifier` we can record as the ack. */
export interface StripeMeterEventResult {
  readonly identifier?: string;
  readonly event_name?: string;
}

/** One Checkout line item: a Stripe price id + quantity (metered items omit quantity). No amounts here. */
export interface CheckoutLineItem {
  readonly price: string;
  readonly quantity?: number;
}

export interface CreateCheckoutArgs {
  /** An EXISTING Stripe customer to attach the subscription to, if we already have one for this org
   *  (billing_customers). Omit for a NEW subscriber — Checkout then creates the customer, and the inbound
   *  webhook records it. Exactly one of customer / customerEmail is the typical shape. */
  readonly customer?: string;
  /** Prefill the email on the Checkout page when there's no existing customer (a new subscriber). */
  readonly customerEmail?: string;
  /** Base licensed price + metered overage price items (ids from config — NO amounts in the repo). */
  readonly lineItems: readonly CheckoutLineItem[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** OUR org id — set as client_reference_id AND on the subscription's metadata so the inbound webhook
   *  resolves org from a SIGNED value we control, never email. */
  readonly orgId: string;
  /**
   * OPTIONAL retry-dedup key for a double-submit within Stripe's ~24h idempotency window. Deliberately
   * caller-supplied (not a fixed `checkout:{org}`): a Checkout Session is a hosted page that charges
   * NOTHING until the user completes it, so a duplicate session is harmless — and a PERMANENT org-scoped
   * key would wrongly return a stale/expired session on a legitimate later re-checkout. The caller passes a
   * per-ATTEMPT token (e.g. a nonce it just minted) when it wants to collapse a fast double-click.
   */
  readonly idempotencyKey?: string;
}

export interface StripeClient {
  /** Low-level: POST form-encoded params to a Stripe path; throws StripeError on a non-2xx. */
  request<T = Record<string, unknown>>(
    path: string,
    params: StripeParams,
    idempotencyKey?: string,
  ): Promise<T>;
  /** Create a Stripe customer carrying our org id in metadata (the durable org↔customer link source). */
  createCustomer(args: { orgId: string; email?: string }): Promise<{ id: string }>;
  /** Create a hosted Checkout Session (mode=subscription) for the base + overage prices. */
  createCheckoutSession(args: CreateCheckoutArgs): Promise<StripeHostedSession>;
  /** Create a hosted Customer Portal session (manage/cancel the subscription). `idempotencyKey` optional. */
  createPortalSession(args: {
    customer: string;
    returnUrl: string;
    idempotencyKey?: string;
  }): Promise<StripeHostedSession>;
  /** Report one metered-usage event to a Stripe Billing Meter (the outbox drainer's send step). */
  reportMeterEvent(args: ReportMeterEventArgs): Promise<StripeMeterEventResult>;
  /** Retrieve a subscription — its status + items (each with its `si_…` id and current price id). The plan
   *  switch reads this to find which item holds the base vs the overage price before remapping them. */
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  /**
   * Update a subscription's price items in place (the plan switch), with a proration behavior.
   * `create_prorations` (WS4) credits/charges the mid-cycle difference on the next invoice. Idempotency-Key
   * optional (a per-attempt token collapses a double-click; a switch is otherwise not naturally idempotent).
   */
  updateSubscription(args: {
    subscriptionId: string;
    items: readonly SubscriptionItemRef[];
    prorationBehavior: "create_prorations" | "none" | "always_invoice";
    idempotencyKey?: string;
  }): Promise<StripeSubscription>;
  /**
   * Retrieve one invoice, with its lines FULLY PAGINATED. Stripe embeds only the first 10 lines by default,
   * and a period carrying several proration + metered lines can push the base line off the end — which would
   * silently compute a zero base and refund nothing.
   */
  retrieveInvoice(invoiceId: string): Promise<StripeInvoice>;
  /** A charge's captured + already-refunded amounts, so a refund can be clamped to the remaining headroom
   *  (a support agent or the Portal may already have refunded part of it). */
  retrieveCharge(chargeId: string): Promise<StripeCharge>;
  /** A price + its `event_cap` metadata — the included volume of the plan a given invoice actually bought.
   *  Read per-invoice rather than from the live subscription, which may have switched plans mid-period. */
  retrievePrice(priceId: string): Promise<StripePrice>;
  /**
   * Cancel a subscription IMMEDIATELY (Stripe's DELETE). Sends `prorate=false`: the customer's refund is
   * computed from USAGE (baseFeeRefundMinorUnits), so letting Stripe also issue its own time-based proration
   * credit would pay them twice for the same unused period.
   */
  cancelSubscription(args: {
    subscriptionId: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; status: string }>;
  /**
   * Refund `amountMinorUnits` against a charge. `idempotencyKey` is REQUIRED, not optional: a refund is not
   * naturally idempotent, and a retried request without one moves the money a second time.
   */
  createRefund(args: {
    charge: string;
    amountMinorUnits: number;
    reason?: "requested_by_customer";
    idempotencyKey: string;
  }): Promise<StripeRefund>;
  /** Low-level: GET a Stripe path with a query object (no body). Throws StripeError on a non-2xx. */
  get<T = Record<string, unknown>>(path: string, query?: StripeParams): Promise<T>;
  /**
   * List a customer's meter-event summaries (what Stripe actually AGGREGATED) over a time range, day-grouped.
   * The transport reconciler compares these to what we told Stripe (the outbox `sent` rows). Paginates fully.
   */
  listMeterEventSummaries(args: {
    meterId: string;
    customer: string;
    startTime: number;
    endTime: number;
    valueGroupingWindow?: "hour" | "day";
  }): Promise<MeterEventSummary[]>;
}

/**
 * One line of a Stripe invoice. `amountMinorUnits` is Stripe's `amount`, which is **pre-discount** — a coupon
 * lives in `discount_amounts` and must be netted off, or a discounted subscription over-refunds.
 */
export interface StripeInvoiceLine {
  readonly priceId: string | null;
  readonly amountMinorUnits: number;
  readonly discountMinorUnits: number;
}

/**
 * A Stripe invoice — the only place the base fee's real amount exists (no money figure is committed to this
 * repo), and the object carrying the charge a refund must be issued against.
 *
 * `status` is carried deliberately: a `past_due` subscription's CURRENT-period invoice is `open`, and paying
 * out against anything other than a `paid` current-period invoice refunds a period the customer already used.
 */
export interface StripeInvoice {
  readonly id: string;
  readonly status: string;
  /** The charge that took the money. Null on a zero-value/credit-settled invoice → nothing to refund. */
  readonly charge: string | null;
  readonly paymentIntent: string | null;
  readonly currency: string | null;
  /** What was ACTUALLY captured. The hard ceiling on any refund — `amount` lines are pre-discount. */
  readonly amountPaidMinorUnits: number;
  readonly lines: readonly StripeInvoiceLine[];
}

/** A charge's refundable headroom: what it took, and what has already been given back. */
export interface StripeCharge {
  readonly amountMinorUnits: number;
  readonly amountRefundedMinorUnits: number;
}

/** A Stripe price + the INCLUDED event volume carried in its metadata (`event_cap`). */
export interface StripePrice {
  readonly id: string;
  /** null = unlimited, absent, or unparseable — all fail closed to "no denominator". */
  readonly eventCap: number | null;
}

/** The result of moving money back to the customer. */
export interface StripeRefund {
  readonly id: string;
  readonly status: string;
  readonly amountMinorUnits: number;
}

/** One Stripe meter-event summary: the value Stripe aggregated over [startTime, endTime). */
export interface MeterEventSummary {
  readonly startTime: number;
  readonly endTime: number;
  readonly aggregatedValue: number;
}

/** Guard against infinitely looping a broken `has_more` — far above any real page count. */
const MAX_SUMMARY_PAGES = 1000;

export function makeStripeClient(opts: StripeClientOptions): StripeClient {
  if (!stripeKeyMatchesMode(opts.mode, opts.secretKey)) {
    // The message names neither the key nor its prefix.
    throw new Error("stripe: secret key does not match BILLING_MODE");
  }
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  // Shared response handling — Stripe always returns JSON; guard a non-JSON error page (e.g. a gateway 502)
  // and turn any non-2xx into a typed StripeError. Used by both request() (POST) and get().
  async function handleResponse<T>(res: Response): Promise<T> {
    let body: { error?: { message?: string; type?: string; code?: string } } & Record<
      string,
      unknown
    >;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new StripeError(res.status, `Stripe returned a non-JSON ${res.status} response`);
    }
    if (!res.ok) {
      const e = body.error ?? {};
      throw new StripeError(res.status, e.message ?? `Stripe error ${res.status}`, e.type, e.code);
    }
    return body as unknown as T;
  }

  // A form-bodied write. Stripe takes params in the body for both POST and DELETE (cancel carries `prorate`).
  async function sendForm<T>(
    method: "POST" | "DELETE",
    path: string,
    params: StripeParams,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await doFetch(`${base}/v1${path}`, {
      method,
      headers,
      body: stripeFormEncode(params),
    });
    return handleResponse<T>(res);
  }

  async function request<T>(
    path: string,
    params: StripeParams,
    idempotencyKey?: string,
  ): Promise<T> {
    return sendForm<T>("POST", path, params, idempotencyKey);
  }

  // A GET carries NO body and NO Content-Type; the query goes in the URL. Reuses handleResponse.
  async function get<T>(path: string, query?: StripeParams): Promise<T> {
    const qs = query ? stripeFormEncode(query) : "";
    const res = await doFetch(`${base}/v1${path}${qs ? `?${qs}` : ""}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
    });
    return handleResponse<T>(res);
  }

  return {
    request,
    async createCustomer({ orgId, email }) {
      // Idempotency-Key = our org id, so a retried customer-create for the same org can't mint duplicates.
      return request<{ id: string }>(
        "/customers",
        { email, metadata: { org_id: orgId } },
        `customer:${orgId}`,
      );
    },
    async createCheckoutSession({
      customer,
      customerEmail,
      lineItems,
      successUrl,
      cancelUrl,
      orgId,
      idempotencyKey,
    }) {
      return request<StripeHostedSession>(
        "/checkout/sessions",
        {
          mode: "subscription",
          // Reuse the existing customer if we have one; otherwise let Checkout create it (email prefill).
          // The encoder drops undefined, so exactly the provided one is sent.
          customer,
          customer_email: customer ? undefined : customerEmail,
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: orgId,
          line_items: lineItems.map((li) => ({ price: li.price, quantity: li.quantity })),
          // Stamp our org id on the subscription so every downstream subscription.* webhook carries it.
          subscription_data: { metadata: { org_id: orgId } },
          metadata: { org_id: orgId },
        },
        idempotencyKey,
      );
    },
    async createPortalSession({ customer, returnUrl, idempotencyKey }) {
      return request<StripeHostedSession>(
        "/billing_portal/sessions",
        { customer, return_url: returnUrl },
        idempotencyKey,
      );
    },
    async reportMeterEvent({ eventName, customer, value, identifier, timestamp }) {
      // identifier = {org}:{day} is BOTH Stripe's native meter-event dedup key and our HTTP Idempotency-Key,
      // so a retried report of the same day is a no-op on both layers — a day is never double-billed (F5).
      return request<StripeMeterEventResult>(
        "/billing/meter_events",
        {
          event_name: eventName,
          identifier,
          timestamp,
          payload: { stripe_customer_id: customer, value: String(value) },
        },
        identifier,
      );
    },
    async retrieveSubscription(subscriptionId) {
      const raw = await get<{
        id: string;
        status: string;
        items?: { data?: Array<{ id: string; price?: { id?: string } }> };
        latest_invoice?: string | { id?: string } | null;
      }>(`/subscriptions/${subscriptionId}`);
      // latest_invoice is an id by default, but an object if anything ever expands it. Accept both.
      const li = raw.latest_invoice;
      return {
        id: raw.id,
        status: raw.status,
        items: (raw.items?.data ?? []).map((it) => ({ id: it.id, price: it.price?.id ?? "" })),
        latestInvoiceId: typeof li === "string" ? li : (li?.id ?? null),
      };
    },
    async updateSubscription({ subscriptionId, items, prorationBehavior, idempotencyKey }) {
      const raw = await request<{
        id: string;
        status: string;
        items?: { data?: Array<{ id: string; price?: { id?: string } }> };
        latest_invoice?: string | { id?: string } | null;
      }>(
        `/subscriptions/${subscriptionId}`,
        {
          items: items.map((i) => ({ id: i.id, price: i.price })),
          proration_behavior: prorationBehavior,
        },
        idempotencyKey,
      );
      const li = raw.latest_invoice;
      return {
        id: raw.id,
        status: raw.status,
        items: (raw.items?.data ?? []).map((it) => ({ id: it.id, price: it.price?.id ?? "" })),
        latestInvoiceId: typeof li === "string" ? li : (li?.id ?? null),
      };
    },
    async retrieveInvoice(invoiceId) {
      const raw = await get<{
        id: string;
        status?: string;
        charge?: string | null;
        payment_intent?: string | null;
        currency?: string | null;
        amount_paid?: number;
      }>(`/invoices/${invoiceId}`);

      // Lines are fetched from the dedicated paginated endpoint, never the (max-10) embedded list.
      type RawLine = {
        id: string;
        amount?: number;
        price?: { id?: string } | null;
        discount_amounts?: Array<{ amount?: number }> | null;
      };
      const lines: StripeInvoiceLine[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_SUMMARY_PAGES; page += 1) {
        const body = await get<{ data?: RawLine[]; has_more?: boolean }>(
          `/invoices/${invoiceId}/lines`,
          { limit: 100, starting_after: startingAfter },
        );
        const data = body.data ?? [];
        for (const l of data) {
          lines.push({
            priceId: l.price?.id ?? null,
            // PRE-discount, per Stripe. The discount is reported separately and netted by the caller.
            amountMinorUnits: Number(l.amount ?? 0),
            discountMinorUnits: (l.discount_amounts ?? []).reduce(
              (sum, d) => sum + Number(d.amount ?? 0),
              0,
            ),
          });
        }
        const last = data[data.length - 1];
        if (!body.has_more || !last) break;
        startingAfter = last.id;
      }

      return {
        id: raw.id,
        status: raw.status ?? "",
        charge: raw.charge ?? null,
        paymentIntent: raw.payment_intent ?? null,
        currency: raw.currency ?? null,
        amountPaidMinorUnits: Number(raw.amount_paid ?? 0),
        lines,
      };
    },
    async retrieveCharge(chargeId) {
      const raw = await get<{ amount?: number; amount_refunded?: number }>(`/charges/${chargeId}`);
      return {
        amountMinorUnits: Number(raw.amount ?? 0),
        amountRefundedMinorUnits: Number(raw.amount_refunded ?? 0),
      };
    },
    async retrievePrice(priceId) {
      const raw = await get<{ id: string; metadata?: Record<string, unknown> }>(
        `/prices/${priceId}`,
      );
      // Fail CLOSED on anything not a positive integer — "unlimited", absent, or garbage all become null
      // ("no denominator"), so the refund declines rather than dividing by a value we guessed.
      const cap = raw.metadata?.event_cap;
      const parsed = typeof cap === "string" ? Number(cap) : NaN;
      return {
        id: raw.id,
        eventCap: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
      };
    },
    async cancelSubscription({ subscriptionId, idempotencyKey }) {
      const raw = await sendForm<{ id: string; status: string }>(
        "DELETE",
        `/subscriptions/${subscriptionId}`,
        // prorate=false — we refund on USAGE, so Stripe must not also credit the unused TIME (double credit).
        { prorate: false },
        idempotencyKey,
      );
      return { id: raw.id, status: raw.status };
    },
    async createRefund({ charge, amountMinorUnits, reason, idempotencyKey }) {
      // Guard in the client, not just the caller: a 0/negative/garbage amount reaching Stripe is a money bug,
      // and this is the last place that can still refuse it. Fail loudly rather than send a nonsense request.
      if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
        throw new Error("stripe: refund amount must be a positive integer of minor units");
      }
      const raw = await request<{ id: string; status: string; amount: number }>(
        "/refunds",
        { charge, amount: amountMinorUnits, reason },
        idempotencyKey,
      );
      return { id: raw.id, status: raw.status, amountMinorUnits: Number(raw.amount) };
    },
    get,
    async listMeterEventSummaries({ meterId, customer, startTime, endTime, valueGroupingWindow }) {
      const out: MeterEventSummary[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_SUMMARY_PAGES; page += 1) {
        const body = await get<{
          data?: Array<{
            id: string;
            start_time: number;
            end_time: number;
            aggregated_value: number;
          }>;
          has_more?: boolean;
        }>(`/billing/meters/${meterId}/event_summaries`, {
          customer,
          start_time: startTime,
          end_time: endTime,
          value_grouping_window: valueGroupingWindow ?? "day",
          limit: 100,
          starting_after: startingAfter,
        });
        const data = body.data ?? [];
        for (const d of data) {
          out.push({
            startTime: d.start_time,
            endTime: d.end_time,
            aggregatedValue: Number(d.aggregated_value),
          });
        }
        const last = data[data.length - 1];
        if (!body.has_more || !last) break;
        startingAfter = last.id;
      }
      return out;
    },
  };
}
