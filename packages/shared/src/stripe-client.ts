// The OUTBOUND Stripe API client (S4.4b) — the counterpart to the audited INBOUND verifier
// (packages/webhooks-spec stripe adapter). A thin, dependency-free fetch wrapper over Stripe's REST API:
// form-urlencoded bodies (Stripe's bracket notation for nested params), Bearer sk_ auth, an optional
// Idempotency-Key, and a pinned Stripe-Version. NO Stripe SDK (Workers-friendly, auditable, no supply
// chain). The secret key is passed in (read from a Secrets Store binding by the caller) and NEVER logged.
// The client is MODE-AGNOSTIC — whether Stripe is called at all is the caller's BILLING_MODE gate; a `test`
// key hits Stripe's sandbox, a `live` key real money, with identical code.

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
}

export function makeStripeClient(opts: StripeClientOptions): StripeClient {
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(
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
      method: "POST",
      headers,
      body: stripeFormEncode(params),
    });
    // Stripe always returns JSON; guard against a non-JSON error page (e.g. a gateway 502).
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
  };
}
