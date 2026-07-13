// The public client: a typed, hardened facade over the webhook.co REST API. It composes the HTTP core
// (bearer + retries + timeout + typed errors), the redactor, and the cursor paginator, and exposes the
// API surface grouped by resource. Idempotency flags mirror the server's semantics exactly — a call is
// only marked retry-safe when a blind retry after a lost response cannot cause a duplicate side effect.

import { base64ToBytes } from "./base64.js";
import { DEFAULT_BASE_URL, resolveBaseUrl } from "./config.js";
import { WebhookConfigError, WebhookUnexpectedResponseError } from "./errors.js";
import { createHttpClient, type HttpClient } from "./http.js";
import { Paginator, type Page } from "./pagination.js";
import { withQuery, type QueryValue } from "./query.js";
import type {
  AddedProviderSecret,
  AuditVerifyResponse,
  AuthContext,
  CreatedEndpoint,
  CreatedReplayDestination,
  DeletedEndpoint,
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
  ReplayDestination,
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
  readonly provider?: readonly Provider[];
  readonly verificationState?: readonly VerificationState[];
  readonly receivedAfter?: string;
  readonly receivedBefore?: string;
  readonly search?: string;
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

class EventsResource {
  constructor(private readonly req: Requester) {}

  private path(endpointId: string, filters: EventsListFilters, cursor: string | undefined): string {
    return withQuery(`/v1/endpoints/${enc(endpointId)}/events`, {
      cursor,
      limit: filters.limit,
      provider: filters.provider as readonly string[] | undefined,
      verificationState: filters.verificationState as readonly string[] | undefined,
      receivedAfter: filters.receivedAfter,
      receivedBefore: filters.receivedBefore,
      search: filters.search,
    } satisfies Record<string, QueryValue>);
  }

  /** Auto-paginating iterator over an endpoint's captured events. */
  list(endpointId: string, filters: EventsListFilters = {}): Paginator<EventSummary> {
    return this.req.paginate<EventSummary>((cursor) => this.path(endpointId, filters, cursor));
  }

  /** A single page of an endpoint's events. */
  listPage(
    endpointId: string,
    params: EventsListFilters & { cursor?: string } = {},
  ): Promise<Page<EventSummary>> {
    return this.req.get<Page<EventSummary>>(this.path(endpointId, params, params.cursor));
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
