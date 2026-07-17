// The public client: a typed, hardened facade over the webhook.co REST API. It composes the HTTP core
// (bearer + retries + timeout + typed errors), the redactor, and the cursor paginator, and exposes the
// API surface grouped by resource. Idempotency flags mirror the server's semantics exactly — a call is
// only marked retry-safe when a blind retry after a lost response cannot cause a duplicate side effect.

import { base64ToBytes } from "./base64.js";
import { DEFAULT_BASE_URL, resolveBaseUrl } from "./config.js";
import { WebhookConfigError, WebhookUnexpectedResponseError } from "./errors.js";
import { makeAdvisoryReporter, type WebhookAdvisory } from "./advisory.js";
import { createHttpClient, type HttpClient } from "./http.js";
import { Paginator, type Page } from "./pagination.js";
import { withQuery, type QueryValue } from "./query.js";
import type {
  AddedProviderSecret,
  AuditVerifyResponse,
  AuthContext,
  CreatedEndpoint,
  CreatedReplayDestination,
  DedupConfig,
  DeletedEndpoint,
  DeletedEvent,
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  EndpointsAddProviderSecretRequest,
  Endpoint,
  EventSummary,
  EventsGetPayloadResponse,
  EventsTailResponse,
  Event as WebhookEvent,
  Provider,
  ProviderSecretSummary,
  RevealedIngestUrl,
  RevokedTrigger,
  ReplayDestination,
  Trigger,
  TriggersList,
  TriggersWaitResult,
  Usage,
  ReplayDestinationDeleted,
  ReplayTarget,
  RevokedProviderSecret,
  RotatedSigningSecret,
  SigningSecretMetadata,
  Subscription,
  SubscriptionDeleted,
  VerificationState,
} from "./schema.js";

export interface WebhookClientOptions {
  /** A `whk_`-prefixed API key. Required. */
  readonly apiKey: string;
  /** The API origin. Defaults to the hosted API; must be https (loopback http allowed for dev). */
  readonly baseUrl?: string;
  /** A `fetch` implementation. Defaults to the runtime global. */
  readonly fetch?: typeof fetch;
  /** Retries after the first attempt for idempotent requests. Default 2. */
  readonly maxRetries?: number;
  /** Per-request wall-clock timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
  /**
   * Reactive auth hook for a rotatable credential (e.g. an OAuth access token): invoked at most once per
   * request on a 401, returning a fresh bearer to retry with, or null to surface the 401.
   */
  readonly refreshAuth?: () => Promise<string | null>;
  /** Optional debug sink; receives already-redacted, single-line diagnostics (never the raw key). */
  readonly onDebug?: (line: string) => void;
  /**
   * Called AT MOST ONCE if the server reports this SDK version is behind (it rides an advisory header on a
   * response you already made — the SDK never polls npm on your behalf).
   *
   * Give a handler and it is yours to log however you like; give none and the SDK writes a single line to
   * stderr. Set `silenceAdvisories` to hear nothing at all.
   */
  readonly onAdvisory?: (advisory: WebhookAdvisory) => void;
  /** Suppress version advisories entirely — including the one-time stderr line. */
  readonly silenceAdvisories?: boolean;

  /** @internal Backoff sleep — a test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** @internal Jitter source — a test seam. */
  readonly rand?: () => number;
  /** @internal Timeout signal factory — a test seam. */
  readonly timeoutSignal?: () => AbortSignal;
}

/** Filters for `endpoints.list`. */
export interface EndpointsListFilters {
  readonly limit?: number;
  readonly name?: string;
}

/** Filters for `events.list`. */
export interface EventsListFilters {
  readonly limit?: number;
  /** Drill into ONE endpoint. Omit for the whole org (the canonical route's default). */
  readonly endpointId?: string;
  readonly provider?: readonly Provider[];
  readonly verificationState?: readonly VerificationState[];
  readonly receivedAfter?: string;
  readonly receivedBefore?: string;
  readonly search?: string;
  /** Multi-select captured HTTP method (GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS). */
  readonly method?: readonly string[];
  /** Multi-select dedup strategy. */
  readonly dedupStrategy?: readonly string[];
  /** Exact match on the normalized, provider-derived event type. */
  readonly eventType?: string;
}

/** Filters for `deliveries.list`. */
export interface DeliveriesListFilters {
  readonly limit?: number;
  readonly destinationId?: string;
  readonly subscriptionId?: string;
  readonly status?: readonly DeliveryStatus[];
}

/** Parameters for a `events.tail` poll. */
export interface EventsTailParams {
  readonly since?: string;
  readonly sinceCursor?: string;
}

/** The decoded result of `events.getPayload`: the content type + the exact raw body bytes. */
export interface EventPayload {
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

const enc = encodeURIComponent;

/** The thin request layer each resource is built on; casts the HTTP core's `unknown` to the typed shape. */
interface Requester {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, idempotent: boolean): Promise<T>;
  patch<T>(path: string, body: unknown, idempotent: boolean): Promise<T>;
  del<T>(path: string, idempotent: boolean): Promise<T>;
  /** A page-following iterator; `buildPath(cursor)` yields the URL for a given cursor. */
  paginate<T>(buildPath: (cursor: string | undefined) => string): Paginator<T>;
}

function makeRequester(http: HttpClient): Requester {
  const get = <T>(path: string): Promise<T> =>
    http.request({ method: "GET", path, idempotent: true }) as Promise<T>;
  return {
    get,
    post: <T>(path: string, body: unknown, idempotent: boolean): Promise<T> =>
      http.request({ method: "POST", path, body, idempotent }) as Promise<T>,
    patch: <T>(path: string, body: unknown, idempotent: boolean): Promise<T> =>
      http.request({ method: "PATCH", path, body, idempotent }) as Promise<T>,
    del: <T>(path: string, idempotent: boolean): Promise<T> =>
      http.request({ method: "DELETE", path, idempotent }) as Promise<T>,
    paginate: <T>(buildPath: (cursor: string | undefined) => string): Paginator<T> =>
      new Paginator<T>((cursor) => get<Page<T>>(buildPath(cursor))),
  };
}

/** Nested resource: an endpoint's provider signing secrets. */
class ProviderSecretsResource {
  constructor(private readonly req: Requester) {}

  /** Register a provider signing secret (or a `verify_token`). NOT idempotent — each call adds a secret. */
  add(input: {
    endpointId: string;
    provider: Provider;
    secret: string;
    label?: string;
    // Sourced from the generated request type so a new server-side kind (e.g. `braintree_public_key`)
    // is never silently unreachable from the SDK.
    kind?: NonNullable<EndpointsAddProviderSecretRequest["kind"]>;
  }): Promise<AddedProviderSecret> {
    const body: Record<string, unknown> = { provider: input.provider, secret: input.secret };
    if (input.label !== undefined) body["label"] = input.label;
    if (input.kind !== undefined) body["kind"] = input.kind;
    return this.req.post<AddedProviderSecret>(
      `/v1/endpoints/${enc(input.endpointId)}/provider-secrets`,
      body,
      false,
    );
  }

  /** An endpoint's provider secrets as metadata (not paginated). */
  async list(endpointId: string): Promise<ProviderSecretSummary[]> {
    const { items } = await this.req.get<{ items: ProviderSecretSummary[] }>(
      `/v1/endpoints/${enc(endpointId)}/provider-secrets`,
    );
    return items;
  }

  /** Revoke a provider secret. NOT idempotent — a re-revoke is NOT_FOUND, so never blind-retried. */
  revoke(input: { endpointId: string; secretId: string }): Promise<RevokedProviderSecret> {
    return this.req.del<RevokedProviderSecret>(
      `/v1/endpoints/${enc(input.endpointId)}/provider-secrets/${enc(input.secretId)}`,
      false,
    );
  }
}

class EndpointsResource {
  readonly providerSecrets: ProviderSecretsResource;
  constructor(private readonly req: Requester) {
    this.providerSecrets = new ProviderSecretsResource(req);
  }

  private path(filters: EndpointsListFilters, cursor: string | undefined): string {
    return withQuery("/v1/endpoints", { cursor, limit: filters.limit, name: filters.name });
  }

  /** Auto-paginating iterator over the org's endpoints. */
  list(filters: EndpointsListFilters = {}): Paginator<Endpoint> {
    return this.req.paginate<Endpoint>((cursor) => this.path(filters, cursor));
  }

  /** A single page of endpoints (for manual cursor control). */
  listPage(params: EndpointsListFilters & { cursor?: string } = {}): Promise<Page<Endpoint>> {
    return this.req.get<Page<Endpoint>>(this.path(params, params.cursor));
  }

  /** A single endpoint by id. */
  get(endpointId: string): Promise<Endpoint> {
    return this.req.get<Endpoint>(`/v1/endpoints/${enc(endpointId)}`);
  }

  /**
   * Create an endpoint. NOT idempotent — each call mints a new endpoint + a fresh ingest URL.
   *
   * The returned `ingestUrl` is a bearer credential, but it is NOT a one-time reveal: the token is sealed
   * at rest, so a lost URL is re-readable any time (POST /v1/endpoints/{id}/reveal-ingest-url, `wbhk
   * endpoints reveal <id>`, or the dashboard) — you do not have to rotate to recover it.
   */
  create(input: { name: string }): Promise<CreatedEndpoint> {
    return this.req.post<CreatedEndpoint>("/v1/endpoints", { name: input.name }, false);
  }

  /** Soft-delete an endpoint. Idempotent — a re-delete returns the recorded deletedAt. */
  delete(endpointId: string): Promise<DeletedEndpoint> {
    return this.req.del<DeletedEndpoint>(`/v1/endpoints/${enc(endpointId)}`, true);
  }

  /**
   * Update an endpoint's dedup config (ADR-0104). Idempotent — it sets the config to a fixed value, so a
   * transient failure is safe to retry. `dedupConfig: null` RESETS to the default (off — log every request).
   */
  update(endpointId: string, input: { dedupConfig: DedupConfig | null }): Promise<Endpoint> {
    return this.req.patch<Endpoint>(`/v1/endpoints/${enc(endpointId)}`, input, true);
  }

  /**
   * Reveal an endpoint's current ingest URL — non-destructive: it does NOT rotate. This is how you recover
   * a FORGOTTEN url; rotating instead would revoke a live credential and break every sender still posting
   * to the old one. The token is sealed at rest (ADR-0101), so the URL is re-readable any time — it is NOT
   * a one-time secret.
   *
   * `ingestUrl` is null ONLY for endpoints created before sealed storage (their plaintext is gone — rotate
   * to mint a fresh, re-readable one).
   *
   * Gated on `endpoints:write` (a key that can rotate can already mint a URL, so revealing the current one
   * is no escalation); every disclosure writes a tamper-evident audit row and is rate-limited. Sent
   * idempotent=false so a blind retry can't double-audit — the same call the CLI makes.
   */
  revealIngestUrl(endpointId: string): Promise<RevealedIngestUrl> {
    return this.req.post<RevealedIngestUrl>(
      `/v1/endpoints/${enc(endpointId)}/reveal-ingest-url`,
      undefined,
      false,
    );
  }

  /**
   * Rotate an endpoint's ingest URL (hard cutover — the old URL stops accepting events immediately, so any
   * sender still posting to it breaks until repointed). For a LEAKED URL: a merely forgotten one can be
   * re-read instead (see `create`). NOT idempotent — never blind-retried.
   */
  rotate(endpointId: string): Promise<CreatedEndpoint> {
    return this.req.post<CreatedEndpoint>(
      `/v1/endpoints/${enc(endpointId)}/rotate`,
      undefined,
      false,
    );
  }
}

/**
 * Turn the one silent-footgun of the org-wide migration into a loud error: `list`/`listPage` used to take
 * `(endpointId, filters)`, they now take `(filters)`. A TypeScript caller gets a compile error, but an
 * UNTYPED JS caller still passing a string id would otherwise have it bound to `filters` — undefined
 * endpointId → a silent whole-org list. Reject a string arg with the migration instead.
 */
function rejectLegacyEndpointIdArg(arg: unknown, method: string): void {
  if (typeof arg === "string") {
    throw new TypeError(
      `events.${method}() no longer takes an endpoint id as its first argument — pass an options ` +
        `object instead: events.${method}({ endpointId: "${arg}" }), or events.${method}() for the whole org.`,
    );
  }
}

class EventsResource {
  constructor(private readonly req: Requester) {}

  /** The shared filter → query mapping (everything except the route + endpointId placement). */
  private filterQuery(
    filters: EventsListFilters,
    cursor: string | undefined,
  ): Record<string, QueryValue> {
    return {
      cursor,
      limit: filters.limit,
      provider: filters.provider as readonly string[] | undefined,
      verificationState: filters.verificationState as readonly string[] | undefined,
      receivedAfter: filters.receivedAfter,
      receivedBefore: filters.receivedBefore,
      search: filters.search,
      method: filters.method,
      dedupStrategy: filters.dedupStrategy,
      eventType: filters.eventType,
    } satisfies Record<string, QueryValue>;
  }

  /** The CANONICAL route: org-wide by default, or one endpoint via `filters.endpointId`. */
  private canonicalPath(filters: EventsListFilters, cursor: string | undefined): string {
    return withQuery(`/v1/events`, {
      endpointId: filters.endpointId,
      ...this.filterQuery(filters, cursor),
    });
  }

  /** Auto-paginating iterator over captured events — org-wide, or `{ endpointId }` for one endpoint. */
  list(filters: EventsListFilters = {}): Paginator<EventSummary> {
    rejectLegacyEndpointIdArg(filters, "list");
    return this.req.paginate<EventSummary>((cursor) => this.canonicalPath(filters, cursor));
  }

  /** A single page of captured events — org-wide, or `{ endpointId }` for one endpoint. */
  listPage(params: EventsListFilters & { cursor?: string } = {}): Promise<Page<EventSummary>> {
    rejectLegacyEndpointIdArg(params, "listPage");
    return this.req.get<Page<EventSummary>>(this.canonicalPath(params, params.cursor));
  }

  /**
   * @deprecated Use {@link list} with `{ endpointId }`. Hits the deprecated nested route
   * `GET /v1/endpoints/{endpointId}/events`; the canonical `list({ endpointId })` is preferred.
   */
  listByEndpoint(endpointId: string, filters: EventsListFilters = {}): Paginator<EventSummary> {
    return this.req.paginate<EventSummary>((cursor) =>
      withQuery(`/v1/endpoints/${enc(endpointId)}/events`, this.filterQuery(filters, cursor)),
    );
  }

  /**
   * @deprecated Use {@link listPage} with `{ endpointId }`. Hits the deprecated nested route
   * `GET /v1/endpoints/{endpointId}/events`; the canonical `listPage({ endpointId })` is preferred.
   */
  listPageByEndpoint(
    endpointId: string,
    params: EventsListFilters & { cursor?: string } = {},
  ): Promise<Page<EventSummary>> {
    return this.req.get<Page<EventSummary>>(
      withQuery(`/v1/endpoints/${enc(endpointId)}/events`, this.filterQuery(params, params.cursor)),
    );
  }

  /** A single event in full fidelity. */
  get(eventId: string): Promise<WebhookEvent> {
    return this.req.get<WebhookEvent>(`/v1/events/${enc(eventId)}`);
  }

  /** The event's raw body bytes (base64 envelope decoded + length-checked against the declared size). */
  async getPayload(eventId: string): Promise<EventPayload> {
    const env = await this.req.get<EventsGetPayloadResponse>(`/v1/events/${enc(eventId)}/payload`);
    const body = base64ToBytes(env.bodyBase64);
    if (body.byteLength !== env.bytes) {
      throw new WebhookUnexpectedResponseError("the API returned a corrupted payload response");
    }
    return { contentType: env.contentType, body };
  }

  /** Poll the newest events for an endpoint (a single tail read; use the tunnel for live streaming). */
  tail(endpointId: string, params: EventsTailParams = {}): Promise<EventsTailResponse> {
    return this.req.get<EventsTailResponse>(
      withQuery(`/v1/endpoints/${enc(endpointId)}/events/tail`, {
        sinceCursor: params.sinceCursor,
        since: params.since,
      }),
    );
  }

  /**
   * Permanently delete ONE captured event: its content is redacted immediately and its stored payload body
   * is purged shortly after, so it can no longer be read or replayed, and it stops appearing in listings.
   * There is no bulk or filter delete. Idempotent — re-deleting is a no-op, so a retry is safe.
   *
   * This does NOT reduce your metered usage: the event was already counted when it was received.
   */
  delete(eventId: string): Promise<DeletedEvent> {
    return this.req.del<DeletedEvent>(`/v1/events/${enc(eventId)}`, true);
  }

  /** Replay a captured event. Idempotency-keyed → safe to retry a transient failure. */
  replay(input: {
    eventId: string;
    target: ReplayTarget;
    idempotencyKey: string;
  }): Promise<DeliveryAttempt> {
    return this.req.post<DeliveryAttempt>(
      `/v1/events/${enc(input.eventId)}/replay`,
      { target: input.target, idempotencyKey: input.idempotencyKey },
      true,
    );
  }
}

class DeliveriesResource {
  constructor(private readonly req: Requester) {}

  private path(filters: DeliveriesListFilters, cursor: string | undefined): string {
    return withQuery("/v1/deliveries", {
      cursor,
      limit: filters.limit,
      destinationId: filters.destinationId,
      subscriptionId: filters.subscriptionId,
      status: filters.status as readonly string[] | undefined,
    } satisfies Record<string, QueryValue>);
  }

  /** Auto-paginating iterator over the org's outbound deliveries. */
  list(filters: DeliveriesListFilters = {}): Paginator<Delivery> {
    return this.req.paginate<Delivery>((cursor) => this.path(filters, cursor));
  }

  /** A single page of deliveries. */
  listPage(params: DeliveriesListFilters & { cursor?: string } = {}): Promise<Page<Delivery>> {
    return this.req.get<Page<Delivery>>(this.path(params, params.cursor));
  }

  /** A single delivery by id. */
  get(deliveryId: string): Promise<Delivery> {
    return this.req.get<Delivery>(`/v1/deliveries/${enc(deliveryId)}`);
  }
}

class ReplayDestinationsResource {
  constructor(private readonly req: Requester) {}

  /** Register an allowed replay destination. Idempotent server-side (a re-add returns the existing row). */
  create(input: { url: string; label?: string }): Promise<CreatedReplayDestination> {
    const body: Record<string, unknown> = { url: input.url };
    if (input.label !== undefined) body["label"] = input.label;
    return this.req.post<CreatedReplayDestination>("/v1/replay-destinations", body, true);
  }

  /** The org's live replay-destination allowlist (not paginated). */
  async list(): Promise<ReplayDestination[]> {
    const { items } = await this.req.get<{ items: ReplayDestination[] }>("/v1/replay-destinations");
    return items;
  }

  /** Remove (soft-delete) a replay destination. NOT idempotent — a re-delete is NOT_FOUND. */
  delete(destinationId: string): Promise<ReplayDestinationDeleted> {
    return this.req.del<ReplayDestinationDeleted>(
      `/v1/replay-destinations/${enc(destinationId)}`,
      false,
    );
  }

  /**
   * Clear a persistent-failure auto-disable. NOT idempotent — it also resets the consecutive-failure
   * tally, so a blind retry could wipe failures that accrued between the first call and the retry.
   */
  enable(destinationId: string): Promise<ReplayDestination> {
    return this.req.post<ReplayDestination>(
      `/v1/replay-destinations/${enc(destinationId)}/enable`,
      {},
      false,
    );
  }

  /** Set strict-FIFO (`ordered`) mode. Idempotent — converges to the same state on retry. */
  setOrdered(destinationId: string, ordered: boolean): Promise<ReplayDestination> {
    return this.req.post<ReplayDestination>(
      `/v1/replay-destinations/${enc(destinationId)}/ordered`,
      { ordered },
      true,
    );
  }

  /** Rotate the destination's signing secret (revealed once). NOT idempotent — each call mints a new one. */
  rotateSigningSecret(destinationId: string): Promise<RotatedSigningSecret> {
    return this.req.post<RotatedSigningSecret>(
      `/v1/replay-destinations/${enc(destinationId)}/signing-secret`,
      {},
      false,
    );
  }

  /** A destination's signing-secret metadata (not paginated). */
  async listSigningSecrets(destinationId: string): Promise<SigningSecretMetadata[]> {
    const { items } = await this.req.get<{ items: SigningSecretMetadata[] }>(
      `/v1/replay-destinations/${enc(destinationId)}/signing-secrets`,
    );
    return items;
  }
}

class SubscriptionsResource {
  constructor(private readonly req: Requester) {}

  /**
   * Create/upsert a delivery subscription. NOT idempotent — the upsert appends a tamper-evident audit row
   * on each call, so a blind retry would write a phantom audit entry for one user action.
   */
  create(input: {
    sourceEndpointId: string;
    destinationId: string;
    provider?: string | null;
    eventTypes?: readonly string[];
    requireVerified?: boolean;
  }): Promise<Subscription> {
    const body: Record<string, unknown> = {
      sourceEndpointId: input.sourceEndpointId,
      destinationId: input.destinationId,
    };
    if (input.provider !== undefined) body["provider"] = input.provider;
    if (input.eventTypes !== undefined) body["eventTypes"] = input.eventTypes;
    if (input.requireVerified !== undefined) body["requireVerified"] = input.requireVerified;
    return this.req.post<Subscription>("/v1/subscriptions", body, false);
  }

  /** The org's delivery subscriptions, optionally filtered by source endpoint (not paginated). */
  async list(sourceEndpointId?: string): Promise<Subscription[]> {
    const { items } = await this.req.get<{ items: Subscription[] }>(
      withQuery("/v1/subscriptions", { sourceEndpointId }),
    );
    return items;
  }

  /** Remove a delivery subscription. NOT idempotent — a re-delete is NOT_FOUND. */
  delete(subscriptionId: string): Promise<SubscriptionDeleted> {
    return this.req.del<SubscriptionDeleted>(`/v1/subscriptions/${enc(subscriptionId)}`, false);
  }
}

class UsageResource {
  constructor(private readonly req: Requester) {}

  /** The current period's metered usage: events counted, the cap, and whether the org is cap-paused. */
  get(): Promise<Usage> {
    return this.req.get<Usage>("/v1/usage");
  }
}

/** Agent triggers (ADR-0106): the webhook→agent primitive behind `triggers.wait`. */
class TriggersResource {
  constructor(private readonly req: Requester) {}

  /** The org's triggers, optionally narrowed to one endpoint. */
  list(filters: { endpointId?: string } = {}): Promise<TriggersList> {
    return this.req.get<TriggersList>(
      withQuery("/v1/triggers", { endpointId: filters.endpointId }),
    );
  }

  /** Create a trigger. NOT idempotent — each call mints a new one, so it is never blind-retried. */
  create(input: { endpointId: string; name?: string }): Promise<Trigger> {
    return this.req.post<Trigger>("/v1/triggers", input, false);
  }

  /** Revoke a trigger. Idempotent. */
  revoke(triggerId: string): Promise<RevokedTrigger> {
    return this.req.del<RevokedTrigger>(`/v1/triggers/${enc(triggerId)}`, true);
  }

  /**
   * Wait for a trigger's events — ack-by-cursor (ADR-0106).
   *
   * SHORT-poll, not long-poll: it returns immediately with whatever is past `cursor`, so there is no held
   * connection and no special timeout handling. Drain a backlog by re-calling promptly while `caughtUp` is
   * false, then poll on your own cadence once caught up.
   *
   * `cursor` accepts null so a null `nextCursor` round-trips straight back in. Read the semantics carefully:
   * `nextCursor` is null ONLY when you sent no cursor and there were no events — an empty page ECHOES the
   * cursor you sent. So null means "start from the oldest retained event", NOT "caught up". `caughtUp` is
   * the caught-up signal; never infer it from a null cursor. (Passing null back is safe: you re-read from
   * the oldest, which is at-least-once by design — dedup on the event id.)
   *
   *     let cursor = null;
   *     for (;;) {
   *       const page = await client.triggers.wait(id, { cursor });
   *       for (const event of page.events) handle(event);
   *       cursor = page.nextCursor; // feed straight back in
   *       if (page.caughtUp) await sleep(1000); // <- the caught-up signal
   *     }
   *
   * At-least-once: a crash before you persist `nextCursor` re-reads, never loses — dedup on the event id.
   * `includeBody` DEFAULTS TO TRUE server-side (pass false for summary-only, skipping the payload fetch);
   * `maxBodyBytes` clamps the inline body (≤ 64 KiB). `limit` is capped at 200.
   */
  wait(
    triggerId: string,
    opts: {
      cursor?: string | null;
      limit?: number;
      includeBody?: boolean;
      maxBodyBytes?: number;
    } = {},
  ): Promise<TriggersWaitResult> {
    return this.req.get<TriggersWaitResult>(
      withQuery(`/v1/triggers/${enc(triggerId)}/wait`, {
        cursor: opts.cursor,
        limit: opts.limit,
        includeBody: opts.includeBody,
        maxBodyBytes: opts.maxBodyBytes,
      }),
    );
  }
}

class AuditResource {
  constructor(private readonly req: Requester) {}

  /** Verify the org's tamper-evident audit chain. A read (no mutation) → safe to retry. */
  verify(): Promise<AuditVerifyResponse> {
    return this.req.post<AuditVerifyResponse>("/v1/audit/verify", undefined, true);
  }
}

export class WebhookClient {
  readonly endpoints: EndpointsResource;
  readonly events: EventsResource;
  readonly deliveries: DeliveriesResource;
  readonly replayDestinations: ReplayDestinationsResource;
  readonly subscriptions: SubscriptionsResource;
  readonly usage: UsageResource;
  readonly triggers: TriggersResource;
  readonly audit: AuditResource;

  private readonly http: HttpClient;

  constructor(options: WebhookClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new WebhookConfigError("an apiKey is required");
    }
    const baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    const fetchImpl =
      options.fetch ??
      (typeof fetch === "function"
        ? (...args: Parameters<typeof fetch>) => fetch(...args)
        : undefined);
    if (fetchImpl === undefined) {
      throw new WebhookConfigError("no fetch implementation found; pass options.fetch");
    }

    this.http = createHttpClient({
      baseUrl,
      apiKey: options.apiKey,
      fetch: fetchImpl,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      refreshAuth: options.refreshAuth,
      onDebug: options.onDebug,
      // One reporter per client: the advisory fires at most once, not once per request.
      reportAdvisory: makeAdvisoryReporter({
        onAdvisory: options.onAdvisory,
        silent: options.silenceAdvisories,
      }),
      sleep: options.sleep,
      rand: options.rand,
      timeoutSignal: options.timeoutSignal,
    });

    const req = makeRequester(this.http);
    this.endpoints = new EndpointsResource(req);
    this.events = new EventsResource(req);
    this.deliveries = new DeliveriesResource(req);
    this.replayDestinations = new ReplayDestinationsResource(req);
    this.subscriptions = new SubscriptionsResource(req);
    this.usage = new UsageResource(req);
    this.triggers = new TriggersResource(req);
    this.audit = new AuditResource(req);
  }

  /** Resolve the caller's own identity (validates the key). */
  whoami(): Promise<AuthContext> {
    return this.http.request({
      method: "GET",
      path: "/v1/whoami",
      idempotent: true,
    }) as Promise<AuthContext>;
  }
}
