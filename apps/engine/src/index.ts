import { authorizeBearer, type BearerAuthzDeps } from "@webhook-co/contract";
import {
  advancePurgeJob,
  API_RESOURCE,
  claimEventPurgeJobs,
  claimPurgeJobs,
  completeEventPurgeJob,
  createClient,
  createCredentialHasherFromBase64,
  createIngestResolver,
  CREDENTIAL_CACHE_TTL_SECONDS,
  DEFAULT_CAP_PRODUCER_LIMIT,
  DEFAULT_METER_RECONCILE_LIMIT,
  DEFAULT_TRANSPORT_LIMIT,
  DEFAULT_TRANSPORT_LOOKBACK_DAYS,
  DEFAULT_TRANSPORT_SETTLE_LAG_MS,
  DEFAULT_METER_REPORTER_LIMIT,
  DEFAULT_METERING_ROLLUP_LIMIT,
  DEFAULT_DELIVERY_STATS_ROLLUP_LIMIT,
  DELIVERY_STATS_SETTLE_DAYS,
  DEFAULT_RECONCILE_LIMIT,
  runDeliveryStatsRollup,
  makeCapTransitionEvictor,
  makeIngestHashEvictor,
  reconcileMeteringUsage,
  reconcileStripeTransport,
  type MeterSummaryReader,
  runCapProducer,
  isTotalFreeOrgCapFailure,
  runFreeOrgCapReconcile,
  runMeterReporter,
  enqueueAutoDeliveries,
  fromCachedSealedSecret,
  getEndpoint,
  INGEST_TOKEN_PREFIX,
  insertIngestEvent,
  listDestinationsWithDueDeliveries,
  looksLikeCredential,
  makeApiKeyAuthDeps,
  makeApiKeyLastUsedStamper,
  readAuditChainHeads,
  readSealedIngestToken,
  revealIngestTokenCore,
  runUsageRollup,
  withTenant,
  type ResolvedPrincipal,
} from "@webhook-co/db";
import {
  AwsKmsProvider,
  b64ToBytes,
  type EncryptionContext,
  importAuditKey,
  importListenTicketKey,
  type KmsProvider,
  LISTEN_SUBPROTOCOL,
  LISTEN_TICKET_SUBPROTOCOL_PREFIX,
  type ListenTicketGrant,
  MAX_VERIFIABLE_BODY_BYTES,
  OrgScopedDekCache,
  billingEnabled,
  reconcileLookbackDays,
  makeStripeClient,
  parseBillingMode,
  stripeKeyMatchesMode,
  parseFreeEventCap,
  parseSince,
  isWellFormedPayloadKey,
  readPayloadKey,
  readSecretBinding,
  USAGE_SETTLE_DAYS,
  type BoundedPayloadBody,
  type ReadBoundedBodiesArgs,
  type RevealedIngestToken,
  type SealedRecord,
  SecretStore,
  verifyListenTicket,
} from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";
import { MAX_FREE_ORGS_PER_USER } from "@webhook-co/shared/plans";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  claimRetentionOrgs,
  deleteExpiredEvents,
  listExpiringEvents,
} from "@webhook-co/db/retention";
import { existingPayloadKeys } from "@webhook-co/db/orphan-sweep";

import { runAnchorCron } from "./anchor-cron";
import { runEventPayloadPurgeCron } from "./event-payload-purge-cron";
import { parseOrphanSweepDelete, runOrphanSweep } from "./orphan-sweep-cron";
import { runPayloadPurgeCron } from "./payload-purge-cron";
import { runReconcileCron } from "./reconcile-cron";
import { isTotalRetentionFailure, runRetentionPruneCron } from "./retention-prune-cron";
import {
  guardedDeliver,
  makeSignDelivery,
  resolveViaDoh,
  type DeliverArgs,
  type DeliverResult,
} from "./delivery-dispatcher";
import {
  ALLOW_METHODS,
  handleIngest,
  ingestPathToken,
  LIVENESS_HEADERS,
  plain,
  SUPPORTED_METHODS,
  type IngestDeps,
  type ResolvedEndpoint,
  type VerificationOutcome,
  type VerifyIngestInput,
} from "./ingest";
import { makeKeyFetcher } from "./key-fetch";
import { readBoundedBodiesCore, type PayloadEventRow } from "./payload-reader";
import { makeVerifyIngest } from "./verify";

// The per-session listen-tunnel Durable Object (Slice 11b, ADR-0014); wrangler binds it via
// LISTEN_SESSION. Re-exported here so the class is registered on the engine Worker entrypoint.
// NOTE: export ONLY the DO class from the worker entry. workerd validates every named export of the
// entry module as a potential entrypoint/handler, so re-exporting a NON-class value here (e.g. the
// numeric POLL_INTERVAL_MS) crashes `wrangler dev` with "Incorrect type for map entry …: not a function
// or ExportedHandler". POLL_INTERVAL_MS is internal to ./listen-session and needs no re-export here.
export { ListenSession } from "./listen-session";
export { DeliveryDO } from "./delivery-do";

// The webhook engine Worker. `fetch` is the wbhk.my write path (cookieless, path-token ingest);
// `scheduled` runs the WORM head-anchor cron (ADR-0004). Handlers stay thin: validate -> delegate
// -> respond, and ACK fast. The security-critical ingest orchestration lives in handleIngest
// (unit-tested with fakes); this file wires the real per-request deps and routes to it.

export interface Env {
  /** Cache-disabled Hyperdrive config for authenticated tenant-scoped reads (api./app.). */
  HYPERDRIVE_TENANT: Hyperdrive;
  /** webhook_authn Hyperdrive (caching OFF): the cold endpoint-token lookup (org-discovery-by-hash). */
  HYPERDRIVE_AUTHN: Hyperdrive;
  /** webhook_ingest Hyperdrive (caching OFF): the single-statement ingest_event insert. */
  HYPERDRIVE_INGEST: Hyperdrive;
  /** R2 bucket holding per-event payload bodies (key = payloadR2Key(org, endpoint, dedup)). */
  R2_PAYLOADS: R2Bucket;
  /** KV namespace caching endpoint resolution (keyed by ingest-token hash). */
  KV_CONFIG: KVNamespace;
  // Secrets are Cloudflare Secrets Store bindings (`secrets_store_secrets`, injected at deploy) — read
  // via `await readSecretBinding(env.X)`. The shared trio (CREDENTIAL_PEPPER / CURSOR_KEY /
  // AUDIT_CHAIN_HMAC_KEY) is ONE account secret bound into engine + api + mcp (byte-identical by
  // construction). None are DB columns.
  /** Base64 credential pepper: keys the ingest-token + api-key HMAC (same pepper across surfaces). */
  CREDENTIAL_PEPPER: SecretsStoreSecret;
  // AWS KMS KEK custodian (ADR-0007 / ADR-0009 day-one KMS) for the KmsProvider seam — wraps/unwraps
  // the per-secret DEKs that seal provider signing secrets (envelope.ts). AwsKmsProvider calls
  // GenerateDataKey/Decrypt over SigV4; the KEK itself never leaves AWS. ARN/region aren't strictly
  // secret but ride the same store for uniform handling + to keep the account-id ARN out of the repo.
  /** The symmetric KMS key ARN (the KEK). */
  KMS_KEY_ARN: SecretsStoreSecret;
  /** AWS region of the KMS key (e.g. "us-east-2"). */
  AWS_REGION: SecretsStoreSecret;
  /** Access key id of the least-privilege IAM principal (kms:GenerateDataKey + kms:Decrypt on the ARN). */
  AWS_ACCESS_KEY_ID: SecretsStoreSecret;
  /** Secret access key of that principal. */
  AWS_SECRET_ACCESS_KEY: SecretsStoreSecret;
  /** Hyperdrive config for the webhook_anchor cross-org head read (query caching off). */
  HYPERDRIVE_ANCHOR: Hyperdrive;
  /** Hyperdrive config for the webhook_reconciler cross-org due-delivery read (query caching off). */
  HYPERDRIVE_RECONCILER: Hyperdrive;
  /** Hyperdrive config for the webhook_purge cross-org payload-purge drain (query caching off).
   *  Optional: absent until the purge role + Hyperdrive are provisioned, so the drain ships dark. */
  HYPERDRIVE_PURGE?: Hyperdrive;
  /** Hyperdrive config for the webhook_retention cross-org retention-prune drain (query caching off).
   *  Optional: absent until the retention role + Hyperdrive are provisioned, so the prune ships dark.
   *  Its presence ALSO clamps the meter-reconcile lookback strictly inside the Free window (they must
   *  activate together — see runMeteringReconcileCron + reconcileLookbackDays). */
  HYPERDRIVE_RETENTION?: Hyperdrive;
  /** Hyperdrive config for the webhook_meter cross-org metering-enumeration read (query caching off). */
  HYPERDRIVE_METER: Hyperdrive;
  /** Hyperdrive config for the webhook_capreconciler cross-user free-org-cap reconcile (query caching off).
   *  Optional: absent until the reconciler role + Hyperdrive are provisioned, so the cron ships dark. */
  HYPERDRIVE_CAPRECONCILER?: Hyperdrive;
  /**
   * Hyperdrive config for the webhook_meter_audit cross-org RECONCILIATION read (S4.4d, F6 — query caching
   * off). OPTIONAL: present only once the audit role + Hyperdrive are provisioned; while absent the
   * reconciliation cron skips (dark), so this ships without blocking the deploy.
   */
  HYPERDRIVE_METER_AUDIT?: Hyperdrive;
  /**
   * The webhook_meter_transport Hyperdrive (WS1) — a read-only cross-org connection for the Stripe
   * transport reconciler (outbox `sent` rows + org→customer map). Optional; unset → that cron is dark.
   */
  HYPERDRIVE_METER_TRANSPORT_AUDIT?: Hyperdrive;
  /** R2 bucket holding the WORM head anchors (retention-locked; this writer has no delete rights). */
  R2_AUDIT_ANCHOR: R2Bucket;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with (shared across surfaces). */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
  /** Per-session hibernatable listen-tunnel Durable Objects (Slice 11b, ADR-0014). */
  LISTEN_SESSION: DurableObjectNamespace;
  /**
   * The per-destination outbound delivery DOs (S3 Slice 3). One instance per replay destination
   * (idFromName(destinationId)) owns that destination's FIFO queue + alarm-driven retry/backoff/dead-letter.
   * Reached only from within the engine (the DeliveryEnqueuer entrypoint fronts it for the api/ingest).
   */
  DELIVERY_DO: DurableObjectNamespace<import("./delivery-do").DeliveryDO>;
  /** KV caching resolved principals for the tunnel bearer chain (mirrors apps/api KV_AUTHZ). */
  KV_AUTHZ: KVNamespace;
  /** Base64 HMAC key for opaque pagination cursors — must equal apps/api CURSOR_KEY (shared secret). */
  CURSOR_KEY: SecretsStoreSecret;
  /**
   * Base64 32-byte HMAC key for the dashboard live-events LISTEN TICKET — byte-identical in the web worker
   * (mint) and here (verify). Lets the browser open `/listen` without an api-key bearer (wbhk.my is
   * cookieless + the WS API can't send Authorization). Read via `readSecretBinding`.
   */
  LISTEN_TICKET_KEY: SecretsStoreSecret;
  /**
   * Optional non-prod dashboard origin (dev/preview) added to the listen-ticket Origin allowlist alongside
   * the committed prod origin. Unset in prod. A committed VAR, not a secret.
   */
  DASHBOARD_ORIGIN?: string;
  /**
   * The Free tier's ONE-TIME LIFETIME event allowance for orgs WITHOUT an explicit org_limits row (S4.3
   * soft-cap; ADR-0004 amended 2026-07-09 — counted over all time, never resets). A tier figure,
   * so it is INJECTED at deploy (not committed) and kept out of the repo. Unset/blank = uncapped (no
   * Free-pause enforcement) — a fail-safe default; setting it is the enable-Free-enforcement switch.
   */
  FREE_EVENT_CAP?: string;
  /**
   * Whether the orphan-sweep cron (S6c-iii) may ACTUALLY delete identified orphans. Fail-safe default: unset
   * / anything but "true" → COUNT-ONLY (the sweep finds + logs orphans but deletes nothing). Set to "true"
   * (a deploy VAR) to enable deletion — a founder switch, flipped after eyeballing the count-only passes,
   * because a stranded-body delete is irreversible and cross-org.
   */
  ORPHAN_SWEEP_DELETE?: string;
  /**
   * Billing mode (off | test | live) — gates the S4.4 outbound Stripe flows (the meter-reporter cron).
   * A committed VAR. Unset/garbage → off (fail-safe: no Stripe call, the reporter no-ops). `live` is the
   * founder-gated real-charge mode; `test` hits Stripe's sandbox with identical code.
   */
  BILLING_MODE?: string;
  /**
   * The Stripe secret key (sk_test_ / sk_live_) — a Secrets Store binding, overlay-injected, never in
   * source/wrangler/CI. Read via `readSecretBinding`, NEVER logged. Only present when billing is provisioned.
   */
  STRIPE_SECRET_KEY?: SecretsStoreSecret;
  /**
   * The Stripe Billing Meter's `event_name` (which meter the metered-overage usage counts against). A
   * committed VAR (a config id, not a secret, not a price). Unset → the reporter has no meter to report to.
   */
  STRIPE_METER_EVENT_NAME?: string;
  /**
   * The Stripe Billing METER id (`mtr_…`) — required by the transport reconciler's event-summaries GET
   * (summaries are addressed by meter id, not event_name). A committed VAR (a config id, not a secret).
   * Unset → the transport reconcile cron is dark.
   */
  STRIPE_METER_ID?: string;
}

// Isolate-scoped DEK handle cache (ADR-0007): unwrapped, non-extractable CryptoKey handles, bounded
// and org-scoped, reused across requests in this isolate so the KMS unwrap is amortized off the hot
// path. The verify function (KMS provider + SecretStore + adapter loop) is likewise built once per
// isolate, lazily on first verify.
const DEK_CACHE = new OrgScopedDekCache({ maxEntries: 256 });
export type VerifyFn = (input: VerifyIngestInput) => Promise<VerificationOutcome>;

/**
 * Memoize an async factory once per isolate, NOT caching a rejected init: a transient config/KMS
 * fault clears the memo so the next request retries rather than poisoning the isolate for its
 * lifetime; concurrent callers share the single in-flight promise. The `env` is captured on the first
 * call (one env per isolate). Backs the lazily-built per-isolate verify fn + seal store.
 */
function memoizeIsolate<A, T>(factory: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let promise: Promise<T> | undefined;
  return (arg) => {
    if (promise === undefined) {
      promise = factory(arg).catch((err: unknown) => {
        promise = undefined;
        throw err;
      });
    }
    return promise;
  };
}

/**
 * Build the production KEK custodian — AWS KMS (ADR-0007 / ADR-0009 day-one KMS), behind the shared
 * KmsProvider seam so callers never branch on the custodian. Fails fast (like the credential pepper)
 * if any required config is missing, so a misconfigured deploy surfaces at construction, not at the
 * first unseal. `AwsKmsProvider.fromConfig` is synchronous and makes no network call here.
 */
export async function kmsProviderFromEnv(env: Env): Promise<KmsProvider> {
  const [keyArn, region, accessKeyId, secretAccessKey] = await Promise.all([
    readSecretBinding(env.KMS_KEY_ARN),
    readSecretBinding(env.AWS_REGION),
    readSecretBinding(env.AWS_ACCESS_KEY_ID),
    readSecretBinding(env.AWS_SECRET_ACCESS_KEY),
  ]);
  if (!keyArn || !region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS KMS config incomplete: KMS_KEY_ARN, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are all required",
    );
  }
  return AwsKmsProvider.fromConfig({ keyArn, region, accessKeyId, secretAccessKey });
}

/**
 * Compose the verify fn over a KEK custodian: a SecretStore (with the isolate DEK cache) + the frozen
 * adapter loop. Exported so tests inject a hermetic LocalKmsProvider rather than reaching AWS — prod
 * passes the AWS custodian from kmsProviderFromEnv. `now` supplies the verification clock (default:
 * real time); makeVerifyIngest itself never throws (it degrades to verified=false).
 */
export function buildVerifyFn(kms: KmsProvider, now: () => Date = () => new Date()): VerifyFn {
  const store = new SecretStore(kms, DEK_CACHE);
  return makeVerifyIngest(
    store,
    now,
    (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
    makeKeyFetcher(), // SSRF-guarded, cached, fail-soft remote key/cert fetch for Tier-3 providers
  );
}

/**
 * Lazily build the per-isolate verify function over the AWS KMS custodian (memoized; see
 * memoizeIsolate). A failing build (incomplete KMS config) isn't cached — handleIngest's verify guard
 * still degrades it to verified=false, never blocking capture.
 */
export const getVerifyFn = memoizeIsolate(async (env: Env) =>
  buildVerifyFn(await kmsProviderFromEnv(env)),
);

/**
 * The per-isolate SECRET-SEALING store backing the ProviderSecretSealer service entrypoint (B0).
 * Distinct from the verify store: sealing only generates fresh DEKs (never unwraps), so it needs NO
 * DEK cache (memoized; see memoizeIsolate).
 */
export const getSealStore = memoizeIsolate(
  async (env: Env) => new SecretStore(await kmsProviderFromEnv(env)),
);

/**
 * The per-isolate UNSEAL store for outbound signing (S3 Slice 2). Unlike getSealStore it must UNWRAP
 * DEKs (to recover the signing secret), so it carries the isolate DEK cache (DEK_CACHE) — the same
 * amortization the verify store uses — so a burst of signed deliveries doesn't issue one KMS Decrypt
 * per delivery. Built lazily + memoized; only awaited on the SIGNED delivery path (the unsigned/legacy
 * path never touches KMS, preserving the ADR-0081 behavior even if KMS config is absent).
 */
export const getSignStore = memoizeIsolate(
  async (env: Env) => new SecretStore(await kmsProviderFromEnv(env), DEK_CACHE),
);

/**
 * The per-isolate UNSEAL store for the GET verification-handshake dispatcher (inbound, S8 Slice 2). Like
 * getSignStore it must UNWRAP DEKs (to recover a per-endpoint secret — e.g. the X CRC consumer secret), so
 * it carries the isolate DEK cache. Dedicated (not getSignStore) so the inbound handshake unseal stays
 * decoupled from outbound signing. Memoized + lazy; only awaited when a GET is a secret-based handshake.
 */
export const getHandshakeUnsealStore = memoizeIsolate(
  async (env: Env) => new SecretStore(await kmsProviderFromEnv(env), DEK_CACHE),
);

/**
 * The per-isolate UNSEAL store for the ingest-URL reveal (S8-remainder Slice 2 / ADR-0101). DEDICATED —
 * NOT getSignStore/getHandshakeUnsealStore — so the reveal path is a distinct, auditable surface that only
 * ever unseals the endpoints' sealed ingest-token column (never a caller-supplied blob). Carries the DEK
 * cache (it UNWRAPS DEKs). Built lazily + memoized; only awaited when a reveal is requested.
 */
export const getRevealStore = memoizeIsolate(
  async (env: Env) => new SecretStore(await kmsProviderFromEnv(env), DEK_CACHE),
);

/** Per-request ingest deps plus the teardown for the DB clients they hold. */
export interface IngestDepsHandle {
  readonly deps: IngestDeps;
  /** Close the per-request DB clients (call in a finally — even on a thrown handler error). */
  close(): Promise<void>;
}

/** Build the per-request ingest deps. Injected in tests so routing is exercised without a live DB. `ctx`
 *  backs the post-ACK deferral (deps.waitUntil) for native auto-delivery. */
export type MakeIngestDeps = (env: Env, ctx: ExecutionContext) => Promise<IngestDepsHandle>;

/**
 * Sanitize a request Content-Type before it becomes R2 object metadata. The header is fully
 * attacker-controlled; a value with control chars / CRLF / absurd length can make R2.put reject,
 * and on the durable-before-ACK path a thrown put turns a well-formed event into a capture-blocking
 * 500 (the provider then retries forever). Keep only printable-ASCII, reasonably-bounded values;
 * drop anything else (the canonical content-type is still persisted in the events row regardless).
 */
export function safeContentType(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  return /^[\x20-\x7e]{1,255}$/.test(contentType) ? contentType : undefined;
}

/** Narrow a resolved principal to the ingest path's endpoint shape (null if it carries no endpoint). */
function toResolvedEndpoint(principal: ResolvedPrincipal | null): ResolvedEndpoint | null {
  if (principal === null || principal.endpointId === undefined) return null;
  return {
    orgId: principal.orgId,
    endpointId: principal.endpointId,
    paused: principal.paused ?? false,
    sealedSecrets: principal.sealedSecrets ?? [],
    dedupConfig: principal.dedupConfig ?? null,
  };
}

/**
 * Construct the live ingest deps from the Worker bindings: a KV-cached endpoint resolver over the
 * webhook_authn cold lookup, an R2 PUT, and the webhook_ingest insert. Two SHORT-LIVED clients per
 * request (one per role), torn down by close(). The pepper is decoded in-worker (a Workers secret,
 * never a process env) and createCredentialHasher validates its length.
 */
export async function buildIngestDeps(env: Env, ctx: ExecutionContext): Promise<IngestDepsHandle> {
  const hasher = createCredentialHasherFromBase64(await readSecretBinding(env.CREDENTIAL_PEPPER));
  // Distinct roles -> distinct connection strings -> distinct clients. Both bindings are
  // cache-disabled: the cold lookup must reflect live pause/rotate state, and the insert is RLS-gated.
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const ingest = createClient(env.HYPERDRIVE_INGEST.connectionString, { max: 1 });
  const resolver = createIngestResolver({
    hasher,
    cache: kvCredentialCache(env.KV_CONFIG),
    authn,
    // Backstop only. A provider-secret mutation evicts THIS endpoint's cached principal explicitly
    // (getEndpointIngestTokenHash + resolver.invalidateHash; ADR-0015), so invalidation -- not this
    // TTL -- is the primary freshness path. Kept at the shared default rather than tightened: the
    // cold path is the expensive cross-cloud Postgres RTT, and the revocation window is bounded by
    // invalidation. Passed explicitly so the value is a visible decision, not an inherited default.
    ttlSeconds: CREDENTIAL_CACHE_TTL_SECONDS,
  });

  const deps: IngestDeps = {
    resolve: async (token) => toResolvedEndpoint(await resolver.resolve(token)),
    // Synchronous best-effort verification. The verify fn (KMS + DEK cache + adapters) is built once
    // per isolate; a thrown init/unseal is caught by handleIngest's guard (capture is never blocked).
    verify: async (input) => (await getVerifyFn(env))(input),
    // Pre-capture unseal for the GET-handshake dispatcher (e.g. the X CRC consumer secret). The AAD is
    // rebuilt from the AUTHORITATIVE orgId/endpointId (not cached.context); keyId = the secret's row id
    // (addProviderSecret binds it). A thrown unseal is caught by handleIngest's handshake guard.
    unsealSecret: async (cached, orgId, endpointId) => {
      const store = await getHandshakeUnsealStore(env);
      const { sealed } = fromCachedSealedSecret(cached);
      return store.openString(sealed, { orgId, endpointId, keyId: cached.id });
    },
    putPayload: async (key, body, contentType) => {
      // The body is the source of truth (HMAC is over these exact bytes); the content-type is only
      // advisory metadata, so a malformed one is dropped rather than allowed to fail the PUT.
      const ct = safeContentType(contentType);
      await env.R2_PAYLOADS.put(
        key,
        body,
        ct !== undefined ? { httpMetadata: { contentType: ct } } : undefined,
      );
    },
    ingestEvent: (row) => insertIngestEvent(ingest, row),
    // Native auto-delivery (S3 Slice 3 PR2c): resolve the source endpoint's matching subscriptions + durably
    // enqueue a delivery per match (webhook_app under the org's RLS via HYPERDRIVE_TENANT), then WAKE each
    // destination's DO to drain. The engine fronts its own DOs, so it reaches them directly (env.DELIVERY_DO)
    // rather than via the DeliveryEnqueuer binding the api uses. handleIngest runs this POST-ACK under
    // ctx.waitUntil (deps.waitUntil), so capture is never blocked by the delivery subsystem. The tenant
    // client is RELEASED as soon as the queued rows commit — the subsequent DO wakes touch no DB, so they
    // must not hold the pooled connection. A failed per-destination wake leaves the queued row durable (the
    // DO drains it on any later wake; PR3's reconciler re-wakes idle destinations).
    autoDeliver: async (args) => {
      const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
      let destinationIds: string[];
      try {
        destinationIds = await enqueueAutoDeliveries(tenant, args);
      } finally {
        await tenant.end().catch(() => undefined); // release before the (DB-free) wake fan-out
      }
      await Promise.all(
        destinationIds.map((destinationId) =>
          env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName(destinationId))
            .wake(args.orgId, destinationId)
            .catch((err: unknown) =>
              console.log(
                JSON.stringify({
                  message: "delivery.wake_failed",
                  destinationId,
                  error: String(err),
                }),
              ),
            ),
        ),
      );
    },
    // Production: run the best-effort auto-delivery task AFTER the capture ACK (ctx.waitUntil holds the
    // isolate alive until it settles), so a delivery-subsystem fault never slows or fails capture.
    waitUntil: (promise) => ctx.waitUntil(promise),
    now: () => new Date(),
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
    maxBodyBytes: MAX_VERIFIABLE_BODY_BYTES,
  };

  return {
    deps,
    close: async () => {
      // Tear down both clients regardless of either's outcome — never leak a pooled connection.
      await Promise.allSettled([authn.end(), ingest.end()]);
    },
  };
}

// The resource identifier (RFC 8707 audience) the tunnel's bearer tokens must be bound to. The CLI
// listen tunnel is the events.tail capability over a WebSocket transport, so it reuses the api.
// audience — existing api keys tunnel unchanged (ADR-0014). API_RESOURCE is single-sourced in @webhook-co/db.
const LISTEN_PRM_URL = `${API_RESOURCE}/.well-known/oauth-protected-resource`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-upgrade auth deps: the bearer authorize gate + the endpoint existence guard (both injectable). */
export interface ListenAuthHandle {
  readonly authDeps: BearerAuthzDeps;
  /** True if the endpoint exists for the org under RLS — the NOT_FOUND-vs-spin-a-DO guard. */
  endpointExists(orgId: string, endpointId: string): Promise<boolean>;
  close(): Promise<void>;
}
/** Build the listen-upgrade auth deps. Injected in tests so the upgrade is exercised without a DB. */
export type MakeListenAuth = (env: Env) => Promise<ListenAuthHandle>;

/** Verify a dashboard listen ticket → its {orgId, endpointId} grant, or null. Injected in tests. */
export type VerifyListenTicketFn = (token: string) => Promise<ListenTicketGrant | null>;

/** The canonical dashboard origin allowed to open a ticket-authed listen socket in prod. */
const DASHBOARD_ORIGIN_PROD = "https://app.webhook.co";

/** Pull the listen ticket out of a `Sec-WebSocket-Protocol` offer list (`wbhk.listen.v1, ticket.<token>`). */
function extractListenTicket(header: string | null): string | null {
  if (!header) return null;
  for (const raw of header.split(",")) {
    const proto = raw.trim();
    if (proto.startsWith(LISTEN_TICKET_SUBPROTOCOL_PREFIX)) {
      const token = proto.slice(LISTEN_TICKET_SUBPROTOCOL_PREFIX.length);
      return token.length > 0 ? token : null;
    }
  }
  return null;
}

/** Fail-closed Origin allowlist for the ticket path: the prod dashboard origin, plus an optional dev override. */
function isAllowedListenOrigin(env: Env, origin: string | null): boolean {
  if (!origin) return false;
  if (origin === DASHBOARD_ORIGIN_PROD) return true;
  return typeof env.DASHBOARD_ORIGIN === "string" && env.DASHBOARD_ORIGIN !== ""
    ? origin === env.DASHBOARD_ORIGIN
    : false;
}

/** The default ticket verifier: import the shared HMAC key + verify against the current clock (Unix seconds). */
async function defaultVerifyListenTicket(
  env: Env,
  token: string,
): Promise<ListenTicketGrant | null> {
  const key = await importListenTicketKey(
    b64ToBytes(await readSecretBinding(env.LISTEN_TICKET_KEY)),
  );
  return verifyListenTicket(key, token, Math.floor(Date.now() / 1000));
}

/**
 * Construct the listen-upgrade deps from the bindings: the api-key bearer chain (mirrors apps/api — a
 * KV-cached resolver over the webhook_authn cold lookup, audience-bound to API_RESOURCE) plus a
 * short-lived tenant client for the endpoint existence guard. Both clients torn down by close().
 */
export async function buildListenAuth(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ListenAuthHandle> {
  const hasher = createCredentialHasherFromBase64(await readSecretBinding(env.CREDENTIAL_PEPPER));
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
  return {
    authDeps: {
      // The tunnel bearer chain, single-sourced; reuses the api audience (KV_AUTHZ shared with api/mcp).
      ...makeApiKeyAuthDeps({
        hasher,
        authn,
        cache: kvCredentialCache(env.KV_AUTHZ),
        resource: API_RESOURCE,
        // Best-effort last_used_at stamp: a self-contained task on its OWN connection, deferred past the
        // response via ctx.waitUntil — never on the auth path, never on the request's authn client.
        stampLastUsed: waitUntil
          ? makeApiKeyLastUsedStamper({
              connectionString: env.HYPERDRIVE_AUTHN.connectionString,
              waitUntil,
            })
          : undefined,
      }),
      resourceMetadataUrl: LISTEN_PRM_URL,
    },
    endpointExists: async (orgId, endpointId) =>
      (await withTenant(tenant, orgId, (tx) => getEndpoint(tx, endpointId))) !== null,
    close: async () => {
      // Tear down both clients regardless of either's outcome — never leak a pooled connection.
      await Promise.allSettled([authn.end(), tenant.end()]);
    },
  };
}

/**
 * The wbhk.my CLI listen-tunnel upgrade. Bearer-authorizes the events.tail capability (cookieless,
 * Authorization header — never a ?token= that would leak into request logs), validates + existence-
 * checks the endpoint under the bearer-derived org's RLS (a clean 404 before spinning a DO), then
 * forwards the upgrade to the per-session LISTEN_SESSION DO with the binding on trusted X-Listen-*
 * headers (set server-side from the verified principal, NEVER from a client). The client learns its
 * session id from the DO's `ready` frame; a reconnect passes ?sessionId= to resume on the same DO.
 */
export async function handleListenUpgrade(
  request: Request,
  env: Env,
  makeAuth: MakeListenAuth = buildListenAuth,
  verifyTicket: VerifyListenTicketFn = (token) => defaultVerifyListenTicket(env, token),
): Promise<Response> {
  const url = new URL(request.url);
  const handle = await makeAuth(env);
  try {
    // Two auth modes funnel here. The CLI presents an api-key BEARER (Authorization header). The dashboard
    // browser can't set Authorization on a WebSocket, so it presents a signed LISTEN TICKET via the
    // Sec-WebSocket-Protocol subprotocol + an Origin the engine allowlists. Either way we resolve a trusted
    // (orgId, endpointId) that the client never controls, then bind the DO from it.
    let orgId: string;
    let endpointId: string | null;
    let userId: string | undefined; // the DO's membership re-check subject (S.8); absent on a userless key
    let acceptSubprotocol: string | undefined;

    // Prefer the bearer path; only take the ticket path when a ticket subprotocol is actually present and
    // there's no Authorization header. A request with NEITHER credential falls through to the bearer path so
    // it still gets the RFC 6750 Bearer challenge (the CLI-facing contract) rather than a bare ticket 401.
    const authHeader = request.headers.get("authorization");
    const ticket = authHeader
      ? null
      : extractListenTicket(request.headers.get("sec-websocket-protocol"));
    if (!ticket) {
      const authz = await authorizeBearer(handle.authDeps, authHeader, "events.tail");
      if (!authz.ok) {
        // 401 (no/invalid/misdirected credential) or 403 (under-scoped) — no socket, RFC 6750 challenge.
        return new Response(null, {
          status: authz.status,
          headers: { "www-authenticate": authz.challenge },
        });
      }
      orgId = authz.ctx.orgId;
      userId = authz.ctx.userId; // present for a grant-bound key; a standalone api key has none (no re-check)
      endpointId = url.searchParams.get("endpointId");
    } else {
      // Dashboard ticket path. Enforce the Origin allowlist FIRST (a cross-origin page must never even
      // attempt to tail), then verify the HMAC ticket. Both org + endpoint come from the SIGNED ticket —
      // the browser controls neither the query string nor any header, so it can't tail another org/endpoint.
      if (!isAllowedListenOrigin(env, request.headers.get("origin"))) {
        return new Response("forbidden origin", { status: 403 });
      }
      const grant = await verifyTicket(ticket);
      if (!grant) return new Response("invalid or expired listen ticket", { status: 401 });
      orgId = grant.orgId;
      endpointId = grant.endpointId;
      userId = grant.userId; // dashboard tickets carry the user so the DO can re-check membership (S.8)
      acceptSubprotocol = LISTEN_SUBPROTOCOL;
    }

    if (!endpointId || !UUID_RE.test(endpointId)) {
      return new Response("invalid or missing endpointId", { status: 400 });
    }
    // Existence guard under the resolved org's RLS: a cross-org or unknown id is NOT_FOUND (and
    // indistinguishable — a caller can't probe another org's endpoints). For the ticket path this is
    // defense-in-depth: the mint-time action already checked the endpoint belongs to the org.
    if (!(await handle.endpointExists(orgId, endpointId))) {
      return new Response("endpoint not found", { status: 404 });
    }

    // Per-session DO: a fresh id on first connect, or the client's id on reconnect (sticky resume).
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const stub = env.LISTEN_SESSION.get(env.LISTEN_SESSION.idFromName(sessionId));

    // Forward the upgrade with the binding on trusted headers, overwriting any client-supplied ones.
    const headers = new Headers(request.headers);
    // Never forward the raw ticket subprotocol to the DO — keep the secret off the internal hop + its logs.
    headers.delete("sec-websocket-protocol");
    headers.set("x-listen-org-id", orgId);
    headers.set("x-listen-endpoint-id", endpointId);
    headers.set("x-listen-session-id", sessionId);
    // Bearer-derived user for the DO's periodic membership re-check (S.8). Always delete first so a client
    // can't inject one; set only when the resolved credential actually carries a user.
    headers.delete("x-listen-user-id");
    if (userId) headers.set("x-listen-user-id", userId);
    // Tell the DO which subprotocol to echo on its 101 (a browser aborts if the server accepts none). Only
    // set for the ticket path; the CLI doesn't offer a subprotocol. Always delete first (never trust client).
    headers.delete("x-listen-accept-subprotocol");
    if (acceptSubprotocol) headers.set("x-listen-accept-subprotocol", acceptSubprotocol);
    // Two mutually exclusive seed modes (the CLI sets one or neither): `?sinceCursor=` is an opaque
    // resume cursor; `?since=` is a grammar (now|beginning|<duration>|<RFC3339>) the server resolves to
    // a boundary cursor. Both at once is an ambiguous request → a clean 400 (mirrors apps/api).
    const sinceCursor = url.searchParams.get("sinceCursor");
    const sinceSpec = url.searchParams.get("since");
    if (sinceCursor !== null && sinceSpec !== null) {
      return new Response("since and sinceCursor are mutually exclusive", { status: 400 });
    }
    // ?sinceCursor=: forward only if it's shaped like a cursor (opaque base64url `<payload>.<mac>`).
    // A control char (CR/LF) would otherwise make headers.set throw → an ungraceful 500; a malformed
    // value is simply dropped (the DO then resumes from its durable cursor / the oldest). The DO
    // still HMAC-verifies it, so this charset check is purely about not crashing on junk input.
    if (sinceCursor && /^[A-Za-z0-9._-]+$/.test(sinceCursor)) {
      headers.set("x-listen-since-cursor", sinceCursor);
    } else {
      headers.delete("x-listen-since-cursor");
    }
    // ?since=<grammar>: validate the grammar HERE so a bad value is a clean 400 before a DO is spun,
    // then forward the raw (validated) spec on a trusted header — the DO resolves it to a boundary
    // cursor server-side under the bound org's RLS, first bind only. A valid grammar contains no CR/LF,
    // so it's header-safe by construction. Always delete first: never trust a client-supplied spec.
    headers.delete("x-listen-since-spec");
    if (sinceSpec !== null) {
      if (parseSince(sinceSpec).kind === "invalid") {
        return new Response("invalid --since value", { status: 400 });
      }
      headers.set("x-listen-since-spec", sinceSpec);
    }

    return stub.fetch(new Request(request, { headers }));
  } finally {
    await handle.close();
  }
}

// The bare apex is a machine-ingest surface, not a landing page: a human who pastes wbhk.my into a
// browser is bounced to the marketing homepage, while GET /healthz stays as the service liveness probe.
// 302 (temporary) — reversible if the root's behaviour ever changes; browsers cache a 301 ~forever.
// Both reuse ingest.ts's LIVENESS_HEADERS (noindex + no-referrer) so the apex hygiene can't drift.
// Root-only: /{token} ingest and /listen are matched below.
const ROOT_REDIRECT_TARGET = "https://www.webhook.co/";

/**
 * The wbhk.my router. GET / 302-redirects to the marketing homepage and GET /healthz is the SERVICE
 * liveness probe (both the bare apex, no token); the /listen WebSocket upgrade is the CLI tunnel; every
 * other request is the ingest write path. handleIngest now accepts ALL standard verbs (accept-all-verbs,
 * ADR-0085) — it captures each (recording the method) and answers a per-token GET/HEAD/OPTIONS with its
 * own browser liveness response, distinct from this bare-apex GET /. Owns per-request DB-client lifecycle:
 * build deps, delegate, and close() in a finally so a thrown handler error never leaks a connection.
 */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  makeDeps: MakeIngestDeps = buildIngestDeps,
): Promise<Response> {
  const url = new URL(request.url);
  // Cleartext refusal (S6a). The ingest token rides in the URL PATH, so a plaintext request has already
  // exposed it — never capture over cleartext (the DPA promises TLS on every external interface). 301 to the
  // https equivalent, path + query preserved, BEFORE /healthz / the root bounce / token resolution, for ALL
  // verbs. This is the version-controlled backstop to the zone's Always-Use-HTTPS (which 301s at the edge
  // before the Worker even runs); the two are defence in depth. HSTS on the https responses then makes a
  // browser auto-upgrade subsequent requests without hitting this path at all.
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return new Response(null, {
      status: 301,
      headers: { location: url.toString(), ...LIVENESS_HEADERS },
    });
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", ...LIVENESS_HEADERS },
    });
  }
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(null, {
      status: 302,
      headers: { location: ROOT_REDIRECT_TARGET, ...LIVENESS_HEADERS },
    });
  }

  // The CLI listen tunnel: a bearer-authed WebSocket upgrade (separate auth/deps from ingest).
  if (url.pathname === "/listen") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    // Bind the last_used_at stamp's waitUntil into the auth builder without changing the seam signature.
    return handleListenUpgrade(request, env, (e) => buildListenAuth(e, (p) => ctx.waitUntil(p)));
  }

  // Uniform method gate FIRST (mirrors handleIngest's, ADR-0085 accept-all-verbs): a non-standard verb is
  // answered with a spec 405 + Allow — the SAME response for a junk path or a real token, so it leaks no
  // token validity. Hoisted ahead of the token pre-filter below so this uniformity is preserved (a rejected
  // verb never falls through to the 404) AND it short-circuits before any DB pool opens.
  if (!SUPPORTED_METHODS.has(request.method)) {
    return plain(405, "method not allowed", { allow: ALLOW_METHODS });
  }

  // Path-token routing: the first path segment is the ingest token. Reject anything that can't be a token
  // in our namespace (vuln-scanner probes — `/.env`, `/config.js`, `/terraform.tfstate`, multi-segment
  // filesystem probes) with a fast 404 BEFORE opening any DB pool / cold lookup. This keeps scanner bursts
  // off the metered cold-lookup path, which was surfacing as transient 500s / worker hangs when the
  // Hyperdrive connection dropped under that junk load. Same 404 (nosniff, no breadcrumbs) an unknown but
  // well-formed token gets — no oracle beyond the already-public token FORMAT (every issued URL shows it).
  if (!looksLikeCredential(INGEST_TOKEN_PREFIX, ingestPathToken(url)))
    return plain(404, "not found");

  // ctx backs deps.waitUntil — native auto-delivery runs AFTER this response is sent (post-ACK best-effort).
  const handle = await makeDeps(env, ctx);
  try {
    return await handleIngest(request, handle.deps);
  } catch (err) {
    // A binding/connection fault (bad pepper, Hyperdrive down) surfaces in observability as a 500,
    // never a silent drop or an ACK of an unpersisted event.
    console.log(JSON.stringify({ message: "ingest.unhandled", error: String(err) }));
    return new Response("internal error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } finally {
    await handle.close();
  }
}

/** The dedicated frequent trigger for the soft-cap producer (S4). Must match a `triggers.crons` entry in
 *  apps/engine/wrangler.jsonc — enforced by scripts/cap-cron-sync-guard.mjs — or the fast pause path is
 *  silently lost and only the hourly backstop enforces the cap (pause latency regresses to ~1h). */
export const CAP_PRODUCER_CRON = "*/5 * * * *";

/** The hourly trigger for the heavy crons (rollup/reconcilers/reporters/purges). Also a `triggers.crons`
 *  entry in apps/engine/wrangler.jsonc; the sync guard asserts wrangler holds EXACTLY these two crons so an
 *  added/renamed trigger can't silently run the heavy jobs on an unexpected cadence. */
export const HOURLY_CRON = "0 * * * *";

/** The crons a scheduled() invocation runs, decided from the cron expression that fired. */
export interface CronPlan {
  /** Run the soft-cap producer this tick. */
  readonly runsCap: boolean;
  /** Run the heavy hourly crons (rollup/reconcilers/reporters/purges) this tick. */
  readonly runsHourly: boolean;
}

/**
 * Decide which crons a scheduled() invocation runs, from the cron expression that fired. Cloudflare
 * dispatches EACH `triggers.crons` entry as its own invocation, so this routes by `controller.cron`.
 *
 * - The dedicated every-5-minutes cap trigger ({@link CAP_PRODUCER_CRON}) runs ONLY the cap producer — a
 *   frequent tick must NOT also run the heavy hourly jobs (12× the work, racing the hourly pass), so it
 *   returns `{cap, !hourly}`.
 * - EVERY other expression (the hourly trigger, or any UNRECOGNISED one) runs the hourly jobs AND the cap
 *   producer as an idempotent backstop. This is the fail-safe: if the frequent cap trigger is ever dropped,
 *   mistyped, or drifts from {@link CAP_PRODUCER_CRON}, the cap is STILL enforced on the hourly tick
 *   (pause latency degrades to ~1h) rather than failing OPEN to unbounded, unbilled over-cap ingest. The
 *   cap producer is safe to run on both triggers: `ingest_paused` is an idempotent upsert and the
 *   threshold-alert insert is `on conflict do nothing`, so a top-of-hour concurrent double-run converges.
 *
 * Whitespace-normalised so a reformatted trigger still matches.
 */
export function scheduledCronPlan(cron: string | undefined): CronPlan {
  const normalised = (cron ?? "").trim().replace(/\s+/g, " ");
  if (normalised === CAP_PRODUCER_CRON) return { runsCap: true, runsHourly: false };
  return { runsCap: true, runsHourly: true };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cloudflare dispatches EACH cron expression as its OWN scheduled() invocation with its own subrequest/
    // CPU budget; `controller.cron` names the one that fired. scheduledCronPlan routes it: the dedicated
    // `*/5` trigger runs ONLY the cap producer (so a pause lands within minutes, S4), while every other
    // trigger runs the heavy hourly jobs AND the cap producer as an idempotent backstop — so a dropped/
    // drifted `*/5` trigger degrades pause latency to ~1h rather than failing OPEN (see scheduledCronPlan).
    const plan = scheduledCronPlan(controller.cron);
    if (plan.runsCap) {
      ctx.waitUntil(
        runCapProducerCron(env).catch((err: unknown) =>
          console.log(JSON.stringify({ message: "cap producer cron failed", error: String(err) })),
        ),
      );
    }
    // A frequent cap tick must NOT also run the heavy hourly jobs (12× the work, racing the hourly pass).
    if (!plan.runsHourly) return;
    // Catch + log here so a config error (bad secret/binding) or a DB outage surfaces in
    // observability rather than as a silent unhandled rejection inside waitUntil.
    ctx.waitUntil(
      runAuditAnchorCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "audit anchor cron failed", error: String(err) })),
      ),
    );
    // The delivery reconciler re-wakes idle DOs that still owe a due delivery (a lost wake, or a re-enabled
    // destination). Independent of the anchor cron — one failing must not sink the other.
    ctx.waitUntil(
      runReconcilerCron(env).catch((err: unknown) =>
        console.log(
          JSON.stringify({ message: "delivery reconciler cron failed", error: String(err) }),
        ),
      ),
    );
    // Metering rollup: derive per-org usage from the exactly-once events rows (no hot-path
    // counter) and freeze aged days into immutable billing snapshots. Independent of the
    // other crons — one failing must not sink the others.
    ctx.waitUntil(
      runMeteringRollupCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "metering rollup cron failed", error: String(err) })),
      ),
    );
    // Delivery-stats rollup (Lane 1.1): pre-aggregate outbound-delivery outcomes per org per day so the
    // /dashboard overview reads O(days), not O(deliveries). A display cache (not billing), so no freeze —
    // recent days just refine as deliveries settle. Independent of the others — one failing must not sink
    // the rest.
    ctx.waitUntil(
      runDeliveryStatsRollupCron(env).catch((err: unknown) =>
        console.log(
          JSON.stringify({ message: "delivery stats rollup cron failed", error: String(err) }),
        ),
      ),
    );
    // Outbound meter reporting (S4.4c): report each paying org's finalized daily usage to Stripe through
    // the outbox. Gated on BILLING_MODE — a no-op when off (the default), so it ships dark. Independent of
    // the rollup cron (it reads the frozen usage the rollup produces, but a failure must not sink it).
    ctx.waitUntil(
      runMeterReporterCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "meter reporter cron failed", error: String(err) })),
      ),
    );
    // Metering reconciliation (S4.4d, money guard F6): independently recount raw events per finalized day
    // and alarm on any drift vs the frozen usage count. Runs whenever the audit Hyperdrive is provisioned
    // (independent of BILLING_MODE — it validates the live metering itself). Independent of the others.
    ctx.waitUntil(
      runMeteringReconcileCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "meter reconcile cron failed", error: String(err) })),
      ),
    );
    // Stripe TRANSPORT reconciliation (WS1): compare what we told Stripe (outbox `sent` rows) to what Stripe
    // aggregated (event summaries) and alarm on any drop. Calls Stripe, so it carries the reporter's full
    // gate stack PLUS the transport Hyperdrive. Independent of the others.
    ctx.waitUntil(
      runMeterTransportReconcileCron(env).catch((err: unknown) =>
        console.log(
          JSON.stringify({ message: "meter transport reconcile cron failed", error: String(err) }),
        ),
      ),
    );
    // Durable payload-body purge: after an owner hard-deletes an org, its R2 payload bodies (outside
    // Postgres) are cleared here in bounded batches until the org's prefix is empty. Dark until the
    // purge role + Hyperdrive are provisioned. Independent of the others — a failure must not sink them.
    ctx.waitUntil(
      runPayloadPurgeDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "payload purge cron failed", error: String(err) })),
      ),
    );
    // Retention prune (data-lifecycle slice 2.3): delete each org's events (+ their R2 payload bodies) once
    // they age past the org's retention window (Free 7d; paid orgs excluded until per-plan windows land).
    // Dark until the retention role + Hyperdrive are provisioned. Independent of the others — a failure must
    // not sink them. NB: provisioning it also clamps the reconcile lookback (runMeteringReconcileCron).
    ctx.waitUntil(
      runRetentionPruneDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "retention prune cron failed", error: String(err) })),
      ),
    );
    // R2 orphan-reconcile sweep (S6c-iii): delete R2 payload objects with NO events row (an insert that
    // failed after the durable-before-ACK PUT, or a prune that crashed before its R2 delete). Bounded per
    // tick, cursor-resumed, triple-fenced (age + shape + anti-join). Reuses the retention Hyperdrive; dark
    // until it's provisioned. Independent of the others — a failure must not sink them.
    ctx.waitUntil(
      runOrphanSweepDrainCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "orphan sweep cron failed", error: String(err) })),
      ),
    );
    // Event-payload purge (S3): delete the R2 body of each user-tombstoned event, then mark the job done.
    // Reuses the webhook_purge role/Hyperdrive (0058 extended it to event_payload_purge). Dark until that
    // Hyperdrive is provisioned; independent of the others — a failure must not sink them.
    ctx.waitUntil(
      runEventPayloadPurgeDrainCron(env).catch((err: unknown) =>
        console.log(
          JSON.stringify({ message: "event payload purge cron failed", error: String(err) }),
        ),
      ),
    );
    // Free-org-cap reconcile (PR2b): across all users, flag → suspend the overflow Free orgs of anyone over
    // the cap, and restore when they resolve it. Dark until the reconciler role + Hyperdrive are provisioned.
    // Independent of the others — a failure must not sink them.
    ctx.waitUntil(
      runFreeOrgCapCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "free-org-cap cron failed", error: String(err) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Seal-only provider-secret sealing over a Cloudflare service binding (Slice B0 / ADR-0078, decision
 * D1). api + mcp RPC `env.<binding>.sealString(plaintext, ctx)` to seal a provider signing secret
 * under the KMS envelope WITHOUT ever holding the KEK custodian — only the engine constructs a
 * SecretStore + the AWS KMS provider, so only the engine can UNSEAL. This entrypoint exposes SEAL
 * ONLY (there is deliberately no open/unseal method), so a compromised api/mcp can register new
 * secrets but can never decrypt existing ones. The binding is worker-to-worker (not public) and
 * deploy-injected into api/mcp via the prod overlay, live once this engine deploys (B1 adds the
 * caller — mirrors how auth.'s IssuerIntrospect/SessionExchange entrypoints shipped before their
 * consumers' bindings). The returned SealedRecord (ciphertext/nonce/wrapped-DEK Uint8Arrays) crosses
 * the binding by structured clone.
 */
export class ProviderSecretSealer extends WorkerEntrypoint<Env> {
  async sealString(plaintext: string, context: EncryptionContext): Promise<SealedRecord> {
    const store = await getSealStore(this.env);
    return store.sealString(plaintext, context);
  }
}

/**
 * Ingest-URL REVEAL over a Cloudflare service binding (S8-remainder Slice 2 / ADR-0101). api + mcp + web
 * RPC `env.<binding>.revealIngestToken(orgId, endpointId)` to recover the always-shown wbhk.my/<token>
 * ingest URL. This is the deliberate counterpart to the seal-only ProviderSecretSealer: the KEK never leaves
 * the engine, so the UNSEAL happens ONLY here. It is IDENTIFIER-ONLY — the caller passes (orgId, endpointId)
 * UUIDs and the engine reads the sealed columns for THAT endpoint itself (never a caller-supplied blob, which
 * would make this a decrypt-anything oracle). The tenant read runs under the org's RLS (`withTenant(orgId)`
 * on HYPERDRIVE_TENANT / webhook_app — an INDEPENDENT tenant check on top of the AAD binding, never a
 * cross-org role), and only ever touches the endpoints ingest columns via a DEDICATED reveal store. Returns
 * `{found, token}`: found=false for an unknown/cross-org endpoint (→ caller NOT_FOUND); token=null for no
 * recoverable copy (→ "rotate to reveal"); an unseal fault propagates (a transient error, not "no copy").
 * The plaintext token crosses the binding by structured clone; the caller builds `${apex}/<token>` + audits.
 */
export class IngestUrlRevealer extends WorkerEntrypoint<Env> {
  async revealIngestToken(orgId: string, endpointId: string): Promise<RevealedIngestToken> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      return await revealIngestTokenCore(
        {
          read: (o, e) => readSealedIngestToken(tenant, o, e),
          unseal: async (sealed, context) => {
            const store = await getRevealStore(this.env);
            return store.openString(sealed, context);
          },
        },
        orgId,
        endpointId,
      );
    } finally {
      await tenant.end({ timeout: 5 }).catch(() => {});
    }
  }
}

/**
 * Ingest-cache eviction over a service binding (WS3, the overage toggle). The web tier flips
 * `org_limits.pause_policy` AND durably reconciles `ingest_paused` in one DB transaction (setOverageEnabled),
 * so enforcement is already correct; this RPC does only what web can't — evict the org's ingest-token entries
 * from the KV cache the ENGINE owns, so the flip is picked up on the next cold miss instead of at the TTL.
 * IDENTIFIER-only: the caller passes its authenticated orgId; the engine reads that org's live endpoint
 * token-hashes UNDER ITS RLS (webhook_app on HYPERDRIVE_TENANT — never a cross-org role) and deletes their
 * cache entries. Best-effort by contract (a per-key KV error is swallowed + logged; the durable ingest_paused
 * row is the source of truth and the TTL is the backstop), so it never rejects on an eviction failure.
 * WorkerEntrypoint methods aren't publicly fetchable; the binding is worker-to-worker, deploy-injected into
 * web via the prod overlay.
 */
export class IngestCacheEvictor extends WorkerEntrypoint<Env> {
  async evictOrgIngestCache(orgId: string): Promise<void> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      const evict = makeIngestHashEvictor(kvCredentialCache(this.env.KV_CONFIG), (err) =>
        console.error(JSON.stringify({ event: "ingest_cache.evict_error", error: String(err) })),
      );
      // Same fan-out the cron's onTransition uses (per-org → every live endpoint's token-hash cache key),
      // integration-tested in cap-producer.test.ts. Wrapped so a transient endpoints-read failure can't
      // reject the RPC — the caller's flip already stands durably; the cache TTL backstops a missed evict.
      await makeCapTransitionEvictor(
        tenant,
        evict,
      )(orgId).catch((err) =>
        console.error(JSON.stringify({ event: "ingest_cache.evict_failed", error: String(err) })),
      );
    } finally {
      await tenant.end({ timeout: 5 }).catch(() => {});
    }
  }
}

/**
 * BOUNDED payload-body read over a service binding (S5 Slice C2). triggers.wait RPCs
 * `env.PAYLOAD_READER.readBoundedBodies({orgId, eventIds, maxBytesEach})` to attach an inline body to each
 * agent-trigger event. The MCP worker has NO R2 binding by design (ADR-0015), so — exactly like
 * IngestUrlRevealer keeps the KEK inside the engine — the R2 bucket never leaves the engine. IDENTIFIER-ONLY:
 * the caller passes its authenticated orgId + event ids; the engine reads each event's stored payload_r2_key
 * UNDER THE ORG'S RLS itself (webhook_app on HYPERDRIVE_TENANT — an independent tenant check, never a
 * cross-org role), fences the key with readPayloadKey (the org/endpoint prefix — a poisoned column can't
 * point at another tenant), then range-reads at most min(maxBytesEach, MAX_INLINE_BODY_BYTES) bytes from R2.
 * A cross-org / unknown event id resolves to found:false (no leak, no oracle). Reads ONLY the R2 payload
 * object — never a sealed column. WorkerEntrypoint methods aren't publicly fetchable; the binding is
 * worker-to-worker, deploy-injected into mcp + api via the prod overlay.
 */
export class PayloadReader extends WorkerEntrypoint<Env> {
  async readBoundedBodies(args: ReadBoundedBodiesArgs): Promise<BoundedPayloadBody[]> {
    // The isolation + bounded-read logic (RLS lookup → key fence → capped range read → per-event failure
    // isolation → 0-byte short-circuit) lives in the injected-deps core (apps/engine/src/payload-reader.ts),
    // so it's provable with fakes. Here we just wire the real deps.
    return readBoundedBodiesCore(
      {
        // Hold the tenant connection ONLY for the RLS id lookup, then release it (the rows are already
        // materialized) — the core's R2 reads run AFTER, connection-free, so a slow/large fetch never pins a
        // Postgres connection across N round-trips.
        lookupEvents: async (orgId, eventIds) => {
          const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
          try {
            return await withTenant(
              tenant,
              orgId,
              (tx) =>
                // `deleted_at is null` self-fences this raw-id body lookup (S3): a tombstoned event's body is
                // redacted + being purged, and this RPC boundary reads by id, so it must never resolve one —
                // even though its sole caller (triggers.wait) already filters upstream (defense in depth).
                tx<PayloadEventRow[]>`
                select id, endpoint_id, payload_r2_key, payload_bytes, content_type
                from events where id in ${tx([...eventIds])} and deleted_at is null`,
            );
          } finally {
            await tenant.end({ timeout: 5 }).catch(() => {});
          }
        },
        readObject: async (key, cap) => {
          const obj = await this.env.R2_PAYLOADS.get(key, { range: { offset: 0, length: cap } });
          return obj === null ? null : new Uint8Array(await obj.arrayBuffer());
        },
      },
      args,
    );
  }
}

/**
 * Server-side remote delivery over a Cloudflare service binding (ADR-0081, S3 slice 1b). apps/api RPCs
 * `env.DELIVERY_DISPATCHER.deliver(args)` to POST a stored event's bytes to a pre-registered remote
 * destination — the engine is the SINGLE SSRF egress chokepoint, so the user-controlled outbound call
 * is made ONLY here, behind the authoritative connect-time guard (DoH-resolve every address → reject any
 * private/internal one → fail-closed → no-redirect). The engine RE-DERIVES the payload key from the
 * authenticated org/endpoint/dedup (never a handed key — H1), so a tenant-boundary slip upstream can't
 * make it read another org's payload. WorkerEntrypoint methods aren't publicly fetchable — the binding is
 * worker-to-worker, deploy-injected into api via the prod overlay, live once this engine deploys (the
 * api consumer binding lands in the next PR — mirrors how ProviderSecretSealer shipped before its caller).
 */
export class DeliveryDispatcher extends WorkerEntrypoint<Env> {
  async deliver(args: DeliverArgs): Promise<DeliverResult> {
    return guardedDeliver(
      {
        getPayload: async (key) => {
          const obj = await this.env.R2_PAYLOADS.get(key);
          return obj === null ? null : await obj.arrayBuffer();
        },
        resolve: (host) => resolveViaDoh((input, init) => fetch(input, init), host),
        fetch: (input, init) => fetch(input, init),
        // S3 Slice 2: unseal the destination's signing secret(s) with the engine's KMS-backed store (the
        // engine alone holds the KEK) + Standard Webhooks-sign. LAZY on purpose — getSignStore is awaited
        // only when guardedDeliver actually invokes `sign` (i.e. a signed delivery), so an unsigned/legacy
        // delivery never touches KMS (preserving the ADR-0081 path even under KMS misconfig). The store is
        // DEK-cached so a burst of signed deliveries amortizes the KMS Decrypt (mirrors the verify store).
        sign: async (signArgs) => makeSignDelivery(await getSignStore(this.env))(signArgs),
        now: () => Date.now(),
      },
      args,
    );
  }
}

/**
 * The enqueue seam for native auto-delivery (S3 Slice 3): a WorkerEntrypoint the api + the ingest worker
 * call to hand a durably-enqueued delivery to its destination's DO. The engine FRONTS its DOs (a
 * DurableObjectNamespace isn't service-bound across workers), so callers reach the DO only through this
 * RPC — they never address `idFromName` directly. The producer has already written the durable `queued`
 * delivery_attempts row; this just wakes the DO to drain. Idempotent (a redundant wake is a no-op).
 */
export class DeliveryEnqueuer extends WorkerEntrypoint<Env> {
  async enqueue(orgId: string, destinationId: string): Promise<void> {
    const stub = this.env.DELIVERY_DO.get(this.env.DELIVERY_DO.idFromName(destinationId));
    // Isolate wake()'s binding-mismatch throw (S.7), like the fan-out and reconciler callers do. The durable
    // `queued` row is ALREADY written by the producer, so a mismatch must not 500 the api caller: the row
    // stays owed and the reconciler cron re-wakes the DO. A mismatch is a mis-scoped-producer anomaly (RLS
    // makes it unreachable in normal flow), so we log it rather than propagate — the guard is defense in
    // depth, not a user-facing error.
    try {
      await stub.wake(orgId, destinationId);
    } catch (err) {
      console.log(
        JSON.stringify({
          message: "delivery.enqueue_wake_failed",
          destinationId,
          error: String(err),
        }),
      );
    }
  }
}

/** Wire the real deps (anchor DB connection, R2 anchor bucket, HMAC key) and run the cron. */
async function runAuditAnchorCron(env: Env): Promise<void> {
  // Decode + validate the HMAC key BEFORE opening a connection. A too-short key would otherwise
  // silently MAC every anchor under a weak key and lock the bad anchors in for the whole retention
  // term. b64ToBytes (shared) is the one cross-runtime base64 decoder.
  const raw = b64ToBytes(await readSecretBinding(env.AUDIT_CHAIN_HMAC_KEY));
  if (raw.length < 32) {
    throw new Error(`AUDIT_CHAIN_HMAC_KEY must decode to >= 32 bytes, got ${raw.length}`);
  }
  const key = await importAuditKey(raw);

  // A short-lived connection as webhook_anchor: its role-targeted policy + column grant scope the
  // read to (org_id, seq, row_hash) across all orgs. Caching is off on this Hyperdrive config.
  const sql = createClient(env.HYPERDRIVE_ANCHOR.connectionString);
  try {
    await runAnchorCron({
      readHeads: () => readAuditChainHeads(sql),
      // Create-only: `If-None-Match: *` makes the put a no-op (returns null) when the key already
      // exists, so a head is anchored exactly once and overlapping runs can't overwrite it.
      putAnchorIfAbsent: async (objectKey, body) =>
        (await env.R2_AUDIT_ANCHOR.put(objectKey, body, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
        })) !== null,
      key,
      now: Date.now(),
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
  } finally {
    await sql.end();
  }
}

/** Max destinations one reconciler pass re-wakes (the db default — well under the Workers subrequest cap). A
 *  capped pass is logged; the next hourly pass continues, with fair random ordering so none is starved. */
const RECONCILE_LIMIT = DEFAULT_RECONCILE_LIMIT;

/**
 * Wire the real deps and run one metering-rollup pass. Two short-lived connections: webhook_meter
 * (cross-org enumeration — role-targeted SELECT policies + column grants scope it to the enumeration
 * keys) and webhook_app via HYPERDRIVE_TENANT (the per-org rollup + freeze run under RLS). The pure,
 * money-correctness-tested core lives in @webhook-co/db (runUsageRollup).
 */
async function runMeteringRollupCron(env: Env): Promise<void> {
  const meter = createClient(env.HYPERDRIVE_METER.connectionString);
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString);
  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  try {
    const rollup = await runUsageRollup({
      meter,
      app,
      now: Date.now(),
      settleDays: USAGE_SETTLE_DAYS,
      limit: DEFAULT_METERING_ROLLUP_LIMIT,
      log,
    });
    log("metering.rollup.done", { ...rollup });
  } finally {
    await Promise.all([meter.end(), app.end()]);
  }
}

/**
 * Wire the real deps and run one delivery-stats rollup pass (Lane 1.1). Same two-connection shape as the
 * metering rollup — webhook_meter enumerates orgs cross-org (already granted select (org_id, created_at) on
 * delivery_attempts, migration 0049), webhook_app re-rolls each settle-window day under RLS. Unlike metering
 * this is a display cache, so the pure core (runDeliveryStatsRollup) has no freeze/immutability logic.
 */
async function runDeliveryStatsRollupCron(env: Env): Promise<void> {
  const meter = createClient(env.HYPERDRIVE_METER.connectionString);
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString);
  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  try {
    const rollup = await runDeliveryStatsRollup({
      meter,
      app,
      now: Date.now(),
      settleDays: DELIVERY_STATS_SETTLE_DAYS,
      limit: DEFAULT_DELIVERY_STATS_ROLLUP_LIMIT,
      log,
    });
    log("delivery_stats.rollup.done", { ...rollup });
  } finally {
    await Promise.all([meter.end(), app.end()]);
  }
}

/**
 * Soft-cap enforcement (S4.3), run on its OWN frequent cron (S4 — every 5 minutes, not the hourly rollup)
 * so a pause lands within MINUTES of an org crossing its limit rather than up to an hour of billed over-cap
 * ingest. It is independent of the rollup: `sumPeriodEventUsage` counts TODAY's events live (not from the
 * frozen `usage` row) and only reads PRIOR days from `usage` (already frozen by earlier rollups), so it is
 * accurate on any tick without a fresh rollup.
 *
 * Flip `ingest_paused` on any pause/resume transition, then evict the org's ingest-token cache entries so it
 * takes effect on the next cold miss (a stale positive principal on resume would be a paying-customer
 * outage). The Free default cap is INJECTED (a tier figure, never in the repo); unset/blank → uncapped
 * (fail-safe). Parse fail-safe: ONLY a strict positive integer enables Free enforcement — `0`/negative would
 * pause EVERY Free org (a mass outage from one fat-fingered deploy var), and `Number.parseInt` is lenient
 * ("10k"→10), so anything not a clean integer → null (uncapped), logged loudly.
 */
async function runCapProducerCron(env: Env): Promise<void> {
  const meter = createClient(env.HYPERDRIVE_METER.connectionString);
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString);
  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  try {
    const defaultEventCap = parseFreeEventCap(env.FREE_EVENT_CAP);
    if (defaultEventCap === null) {
      if (env.FREE_EVENT_CAP && env.FREE_EVENT_CAP.trim() !== "") {
        log("metering.cap.free_cap_invalid", { raw: env.FREE_EVENT_CAP });
      } else {
        log("metering.cap.free_cap_unset");
      }
    }
    const evict = makeIngestHashEvictor(kvCredentialCache(env.KV_CONFIG), (err) =>
      log("metering.cap.kv_evict_error", { error: String(err) }),
    );
    const cap = await runCapProducer({
      meter,
      app,
      now: Date.now(),
      defaultEventCap,
      limit: DEFAULT_CAP_PRODUCER_LIMIT,
      log,
      // On each transition, evict every live endpoint's ingest-token cache entry for this org so the
      // flipped pause state is picked up on the next cold miss (extracted + integration-tested seam).
      onTransition: makeCapTransitionEvictor(app, evict),
    });
    log("metering.cap.done", { ...cap });
  } finally {
    await Promise.all([meter.end(), app.end()]);
  }
}

/**
 * Wire the real deps and run one outbound meter-reporter pass (S4.4c). GATED on BILLING_MODE: off (the
 * default) → return immediately, no Stripe client is built and no connection is opened, so this is fully
 * dark until billing is deliberately enabled. When enabled it needs the Stripe secret (a Secrets Store
 * binding, never logged) + the meter's event_name (a config VAR); a half-configured billing deploy (mode
 * set but key/meter missing) logs and no-ops rather than erroring. Two short-lived connections mirror the
 * rollup: webhook_meter (cross-org enumeration of paying orgs, migration 0045) + webhook_app via
 * HYPERDRIVE_TENANT (per-org outbox read/write under RLS). The money-correctness core is @webhook-co/db.
 */
async function runMeterReporterCron(env: Env): Promise<void> {
  const mode = parseBillingMode(env.BILLING_MODE ?? null);
  if (!billingEnabled(mode)) return; // dark: BILLING_MODE off/unset → no Stripe, no-op

  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  const eventName = env.STRIPE_METER_EVENT_NAME?.trim();
  const secretKey = env.STRIPE_SECRET_KEY ? await readSecretBinding(env.STRIPE_SECRET_KEY) : "";
  if (!eventName || !secretKey) {
    // Billing is switched on but not fully provisioned — don't error the cron, just skip (fail-safe).
    log("metering.report.not_configured", { hasMeter: !!eventName, hasKey: !!secretKey });
    return;
  }
  // The key must belong to the mode. Reporting TEST usage to a LIVE meter (or the reverse) silently corrupts
  // what a customer is invoiced for, and the meter events are not retractable. Skip rather than report wrong.
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    log("metering.report.key_mode_mismatch"); // never log the key or its prefix
    return;
  }

  const stripe = makeStripeClient({ mode, secretKey });
  const meter = createClient(env.HYPERDRIVE_METER.connectionString);
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString);
  try {
    const result = await runMeterReporter({
      meter,
      app,
      stripe,
      eventName,
      now: Date.now(),
      limit: DEFAULT_METER_REPORTER_LIMIT,
      log,
    });
    log("metering.report.done", { mode, ...result });
  } finally {
    await Promise.all([meter.end(), app.end()]);
  }
}

/**
 * Wire the real deps and run one metering-reconciliation pass (S4.4d, F6). Skips (dark) unless the
 * webhook_meter_audit Hyperdrive is provisioned — a metering-integrity check that runs independently of
 * BILLING_MODE (it validates the live rollup, useful even before billing). One short-lived connection as
 * webhook_meter_audit (its role-targeted SELECT policies + column grants scope it to the recount keys).
 * The pure, money-correctness-tested comparison lives in @webhook-co/db (reconcileMeteringUsage); a drift
 * is logged as `metering.reconcile.drift` (counts + opaque org id only) for an ops alarm to catch.
 */
async function runMeteringReconcileCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_METER_AUDIT) return; // dark until the audit role + Hyperdrive are provisioned
  const audit = createClient(env.HYPERDRIVE_METER_AUDIT.connectionString);
  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  try {
    const result = await reconcileMeteringUsage({
      audit,
      now: Date.now(),
      // Money-guard coupling (slice 2.3): once the retention prune is active (its Hyperdrive is bound),
      // clamp the lookback strictly INSIDE the Free window so we never recount a day whose events may have
      // been pruned and false-alarm. Wide (35d) while the prune is dark. reconcileLookbackDays owns the math.
      lookbackDays: reconcileLookbackDays(!!env.HYPERDRIVE_RETENTION),
      limit: DEFAULT_METER_RECONCILE_LIMIT,
      log,
    });
    // Summary line (the per-drift alarms are logged inside the core). driftCount > 0 is the alert signal.
    log("metering.reconcile.done", {
      daysChecked: result.daysChecked,
      driftCount: result.mismatches.length,
      capped: result.capped,
    });
  } finally {
    await audit.end();
  }
}

/**
 * Stripe TRANSPORT reconciliation (WS1). Reconcile what we TOLD Stripe (the outbox `sent` rows, per UTC day)
 * against what Stripe SAYS it aggregated (meter event summaries). A drift = a meter event Stripe silently
 * dropped (or a stale value) — pure under-/over-billing that nothing else catches. Read-only both sides;
 * alarms only, never auto-adjusts. Dark unless billing is on AND the meter id + key + transport Hyperdrive
 * are all provisioned. Mode-checked so we never compare against the wrong Stripe environment.
 */
async function runMeterTransportReconcileCron(env: Env): Promise<void> {
  const mode = parseBillingMode(env.BILLING_MODE ?? null);
  if (!billingEnabled(mode)) return; // dark: BILLING_MODE off/unset
  if (!env.HYPERDRIVE_METER_TRANSPORT_AUDIT) return; // dark until the transport role + Hyperdrive exist

  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...fields }));
  const meterId = env.STRIPE_METER_ID?.trim();
  const secretKey = env.STRIPE_SECRET_KEY ? await readSecretBinding(env.STRIPE_SECRET_KEY) : "";
  if (!meterId || !secretKey) {
    log("metering.stripe_reconcile.not_configured", { hasMeter: !!meterId, hasKey: !!secretKey });
    return;
  }
  if (!stripeKeyMatchesMode(mode, secretKey)) {
    log("metering.stripe_reconcile.key_mode_mismatch"); // never log the key or its prefix
    return;
  }

  const stripe = makeStripeClient({ mode, secretKey });
  // Adapt the Stripe client's summaries lister into the pure comparator's reader seam.
  const reader: MeterSummaryReader = {
    listDaySummaries: async (customer, startSec, endSec) => {
      const summaries = await stripe.listMeterEventSummaries({
        meterId,
        customer,
        startTime: startSec,
        endTime: endSec,
      });
      return summaries.map((sm) => ({ startSec: sm.startTime, aggregated: sm.aggregatedValue }));
    },
  };
  const audit = createClient(env.HYPERDRIVE_METER_TRANSPORT_AUDIT.connectionString);
  try {
    const result = await reconcileStripeTransport({
      audit,
      reader,
      now: Date.now(),
      settleLagMs: DEFAULT_TRANSPORT_SETTLE_LAG_MS,
      lookbackDays: DEFAULT_TRANSPORT_LOOKBACK_DAYS,
      limit: DEFAULT_TRANSPORT_LIMIT,
      log,
    });
    log("metering.stripe_reconcile.done", {
      daysChecked: result.daysChecked,
      orgsChecked: result.orgsChecked,
      driftCount: result.mismatches.length,
      skippedNoCustomer: result.skippedNoCustomer,
      erroredOrgs: result.erroredOrgs, // > 0 is an alarm: an org's transport check did not run
      capped: result.capped,
    });
  } finally {
    await audit.end();
  }
}

/** Wire the real deps (a webhook_reconciler cross-org connection + the DO waker) and run the reconciler. */
async function runReconcilerCron(env: Env): Promise<void> {
  // A short-lived connection as webhook_reconciler: its role-targeted SELECT policies + column grants scope
  // the read to the reconciliation keys across all orgs. Caching is off on this Hyperdrive config.
  const sql = createClient(env.HYPERDRIVE_RECONCILER.connectionString);
  try {
    await runReconcileCron({
      listDue: () => listDestinationsWithDueDeliveries(sql, RECONCILE_LIMIT),
      // The engine fronts its own DOs, so it wakes them directly. wake() is idempotent — a redundant wake
      // against an already-draining DO is a no-op.
      wake: async (orgId, destinationId) => {
        await env.DELIVERY_DO.get(env.DELIVERY_DO.idFromName(destinationId)).wake(
          orgId,
          destinationId,
        );
      },
      limit: RECONCILE_LIMIT,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
  } finally {
    await sql.end();
  }
}

// Payload-purge drain budget: how many deleted orgs to service and how much R2 work per tick.
// Bounded so a large backlog never blows the Workers per-invocation subrequest/CPU ceiling — the
// remainder resumes on the next tick. PAGE_SIZE is R2's per-call batch-delete ceiling.
const PURGE_JOB_LIMIT = 20;
const PURGE_BATCHES_PER_JOB = 50;
const PURGE_PAGE_SIZE = 1000;

async function runPayloadPurgeDrainCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_PURGE) return; // dark until the purge role + Hyperdrive are provisioned
  // A short-lived connection as webhook_purge: its role-targeted SELECT + column-scoped UPDATE on
  // org_deletions are the sole bound (no access to any tenant table). Caching off on this Hyperdrive.
  const sql = createClient(env.HYPERDRIVE_PURGE.connectionString);
  try {
    await runPayloadPurgeCron({
      claim: (n) => claimPurgeJobs(sql, n),
      // The engine is the sole R2 principal (mirrors the PayloadReader RPC posture) — it deletes a
      // deleted org's bodies directly from its own R2_PAYLOADS binding, prefix by prefix.
      bucket: {
        list: async (opts) => {
          const listed = await env.R2_PAYLOADS.list({
            prefix: opts.prefix,
            cursor: opts.cursor,
            limit: opts.limit,
          });
          return {
            objects: listed.objects.map((o) => ({ key: o.key })),
            truncated: listed.truncated,
            cursor: listed.truncated ? listed.cursor : undefined,
          };
        },
        delete: (keys) => env.R2_PAYLOADS.delete(keys),
      },
      advance: (input) => advancePurgeJob(sql, input),
      jobLimit: PURGE_JOB_LIMIT,
      batchesPerJob: PURGE_BATCHES_PER_JOB,
      pageSize: PURGE_PAGE_SIZE,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
  } finally {
    await sql.end();
  }
}

/** Max event-purge jobs serviced per tick — bounded so the shared invocation budget isn't blown; the rest
 *  resumes next tick (each job is 1 R2 delete + 1 completion write). */
const EVENT_PURGE_JOB_LIMIT = 200;

async function runEventPayloadPurgeDrainCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_PURGE) return; // dark until the purge role + Hyperdrive are provisioned
  // Same short-lived webhook_purge connection posture as the org purge: its role-targeted SELECT +
  // column-scoped UPDATE on event_payload_purge (0058) are the sole bound (no tenant-table access).
  const sql = createClient(env.HYPERDRIVE_PURGE.connectionString);
  try {
    await runEventPayloadPurgeCron({
      claim: (n) => claimEventPurgeJobs(sql, n),
      // The stored key is fenced to its own org+endpoint prefix before delete (readPayloadKey, H1) — a
      // poisoned/cross-tenant key returns null → we skip + alarm, never deleting a victim's object.
      validateKey: (orgId, endpointId, r2Key) => readPayloadKey(orgId, endpointId, r2Key) !== null,
      // The engine is the sole R2 delete principal — it removes the tombstoned event's body directly.
      deleteR2: (key) => env.R2_PAYLOADS.delete(key),
      complete: (eventId) => completeEventPurgeJob(sql, eventId),
      limit: EVENT_PURGE_JOB_LIMIT,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
  } finally {
    await sql.end();
  }
}

// Retention-prune drain budget: how many orgs to service and how much work per org per tick. Bounded so a
// large backlog never blows the Workers per-invocation subrequest budget — the rest resumes next tick, and
// the scheduled() budget is SHARED with the other hourly crons. Worst case per tick ≈ orgLimit × batchesPerOrg
// × (1 list + 1 events delete + 1 R2 delete) = 50 × 40 × 3 = 6,000 binding ops. That is well over the old
// 1,000-subrequest cap Cloudflare REMOVED on 2026-02-11 (paid default is now 10,000, up to 10M); the engine
// wrangler.jsonc raises `limits.subrequests` to 50,000 so this drain plus every sibling hourly cron fits with
// wide margin. `batchesPerOrg` is sized so a SINGLE org drains ≈ 40 × 1,000 × 24 ticks = 960,000 events/day —
// ~10× a Scale org's ~100,000/day — so no org can out-produce its own prune. The orgs drain through a bounded
// concurrency pool (RETENTION_ORG_CONCURRENCY) so a fleet-wide backlog finishes inside the 15-minute cron wall
// time instead of 50 orgs strictly sequential. Concurrency is kept CONSERVATIVE (2): this is a background,
// irreversible-deletion cron whose DELETEs cascade events→delivery_attempts on the SAME shared Neon compute
// the ingest (revenue) path writes to — a higher fan-out could pressure that compute and slow ingest INSERTs
// toward their statement timeout. 2 is real fleet parallelism at a bounded peak; raise it only after watching
// Neon under a real backlog. On first activation the drain still spans many hourly ticks by design. PAGE_SIZE
// is also the R2 batch-delete size (<= 1000, R2's per-call ceiling).
const RETENTION_ORG_LIMIT = 50;
const RETENTION_BATCHES_PER_ORG = 40;
const RETENTION_ORG_CONCURRENCY = 2;
const RETENTION_PAGE_SIZE = 1000;

/**
 * Wire the real deps and run one retention-prune pass (data-lifecycle slice 2.3). Skips (dark) unless the
 * webhook_retention Hyperdrive is provisioned — activating it ALSO clamps the meter-reconcile lookback (see
 * runMeteringReconcileCron), so the money-guard never recounts a pruned day. One short-lived connection as
 * webhook_retention (its role-targeted policies + column grants scope it to the prune keys). For each org
 * past its window (paid orgs excluded at the claim + re-checked atomically in the DELETE), it deletes the
 * event rows first (cascading delivery_attempts) then purges R2 for only the ids the delete returned. Free =
 * 7 days while billing is dark; per-plan windows land with billing activation.
 */
async function runRetentionPruneDrainCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_RETENTION) return; // dark until the retention role + Hyperdrive are provisioned
  const sql = createClient(env.HYPERDRIVE_RETENTION.connectionString);
  try {
    const result = await runRetentionPruneCron({
      // No window is passed in: each org's own `orgs.retention_days` drives the claim, the list, and the
      // delete (0054), and the DELETE policy enforces it independently of anything the app sends.
      claimOrgs: (limit) => claimRetentionOrgs(sql, limit),
      listExpiring: (orgId, limit) => listExpiringEvents(sql, orgId, limit),
      // Principal fence (H1): only act on a stored key that matches its own org/endpoint prefix. Same
      // check every delivery/replay/read path applies — never delete an object whose key is corrupt or
      // points at another tenant.
      validateKey: (orgId, endpointId, r2Key) => readPayloadKey(orgId, endpointId, r2Key) !== null,
      // The engine is the sole R2 principal — it deletes each expiring event's body from its own
      // R2_PAYLOADS binding (idempotent: an already-gone key is a no-op).
      deleteR2: (keys) => env.R2_PAYLOADS.delete(keys),
      deleteEvents: (orgId, ids) => deleteExpiredEvents(sql, orgId, ids),
      orgLimit: RETENTION_ORG_LIMIT,
      orgConcurrency: RETENTION_ORG_CONCURRENCY,
      batchesPerOrg: RETENTION_BATCHES_PER_ORG,
      pageSize: RETENTION_PAGE_SIZE,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
    // Escalate a TOTAL outage (every claimed org threw) by throwing — the scheduled() catch then emits the
    // standard "retention prune cron failed" error line that alerting keys on. A PARTIAL failure does NOT
    // throw (the healthy orgs' deletions are valid). Fail direction is safe either way (data is RETAINED,
    // never wrongly deleted). The decision is the pure, unit-tested `isTotalRetentionFailure`.
    if (isTotalRetentionFailure(result)) {
      throw new Error(`retention prune: all ${result.orgs} claimed orgs failed`);
    }
  } finally {
    await sql.end();
  }
}

/** Grace between first flagging an over-cap Free org and suspending it — the owner's window to resolve. */
const FREE_ORG_CAP_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * How long before the grace deadline the SECOND notice (the T-7 reminder) goes out. Must be < the grace
 * window. It exists for redundancy, not nagging: the notify drain is at-most-once (an intent is claimed
 * pending→sent before the Resend call), so a single 5xx would otherwise lose the only warning and the org
 * would be suspended in silence — the one outcome this whole family exists to prevent.
 */
const FREE_ORG_CAP_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The reminder's floor: never send one with less than this long to act. A second notice landing an hour
 * before the suspension email implies time that isn't there — worse than sending nothing and letting the
 * suspension notice speak for itself. Reachable when the cron gaps across the reminder window.
 */
const FREE_ORG_CAP_MIN_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Free-org-cap reconcile (PR2b slice 3b). Across ALL users, enforce the "at most N owned FREE orgs" rule the
 * best-effort creation gate can't: flag → suspend the overflow of anyone over the cap, and restore an org once
 * its owner resolves the overage. Dark until the webhook_capreconciler role + Hyperdrive are provisioned. One
 * short-lived connection as that role (its role-targeted policies + column grants scope it to the ownership
 * graph + the suspend-lifecycle write). A restored org's held deliveries are re-woken by the hourly delivery
 * reconciler, so this cron needs no DO access.
 */
async function runFreeOrgCapCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_CAPRECONCILER) return; // dark until the reconciler role + Hyperdrive are provisioned
  const sql = createClient(env.HYPERDRIVE_CAPRECONCILER.connectionString);
  try {
    const result = await runFreeOrgCapReconcile(sql, {
      now: Date.now(),
      cap: MAX_FREE_ORGS_PER_USER,
      graceMs: FREE_ORG_CAP_GRACE_MS,
      reminderMs: FREE_ORG_CAP_REMINDER_MS,
      minReminderLeadMs: FREE_ORG_CAP_MIN_REMINDER_LEAD_MS,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
    console.log(JSON.stringify({ message: "free-org-cap reconcile", ...result }));
    // Escalate a TOTAL outage (every org the pass touched threw) by throwing — the scheduled() catch then
    // emits the "free-org-cap cron failed" error line that alerting keys on. Without this, a deterministic
    // failure (a regressed grant, a rolled-back 0086) leaves the cap 100% unenforced every hour behind an INFO
    // line shaped exactly like a healthy pass. A PARTIAL failure does not throw — the healthy orgs' work is
    // valid and each failure was logged individually. Same shape as the retention prune above.
    if (isTotalFreeOrgCapFailure(result)) {
      throw new Error(
        `free-org-cap reconcile: a phase wholly failed — ${JSON.stringify(result.phases)}`,
      );
    }
  } finally {
    await sql.end();
  }
}

// R2 orphan-reconcile sweep (S6c-iii). One R2 list page per tick, cursor-resumed across ticks (KV). The
// safety window is DELIBERATELY generous — a stranded orphan is permanent, so waiting to reclaim it costs
// nothing, and the window must dwarf the ingest PUT→insert latency (milliseconds) by orders of magnitude so
// an in-flight event's body is never touched. PAGE_SIZE bounds both the R2 list and the one `in (…)`
// anti-join query.
const ORPHAN_SWEEP_PAGE_SIZE = 1000;
const ORPHAN_SWEEP_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — vastly above any PUT→insert latency
const ORPHAN_SWEEP_CURSOR_KEY = "orphan-sweep:r2-cursor";

/**
 * Wire the real deps and run one orphan-sweep pass (S6c-iii). Reuses the webhook_retention connection for the
 * cross-org `events.payload_r2_key` anti-join (migration 0053 grants it that column, cross-org) + the
 * R2_PAYLOADS binding (the engine is the sole R2 delete principal) + KV_CONFIG for the resumable list cursor.
 * Dark until the retention Hyperdrive is provisioned (same gate as the prune — both are the R2-cleanup lane).
 */
async function runOrphanSweepDrainCron(env: Env): Promise<void> {
  if (!env.HYPERDRIVE_RETENTION) return; // dark until the retention role + Hyperdrive are provisioned
  const sql = createClient(env.HYPERDRIVE_RETENTION.connectionString);
  try {
    await runOrphanSweep({
      readCursor: () => env.KV_CONFIG.get(ORPHAN_SWEEP_CURSOR_KEY),
      listPage: async (cursor, limit) => {
        const listed = await env.R2_PAYLOADS.list({
          prefix: "org/",
          cursor: cursor ?? undefined,
          limit,
        });
        return {
          objects: listed.objects.map((o) => ({ key: o.key, uploadedMs: o.uploaded.getTime() })),
          // `truncated` false = last page → null cursor tells the sweep the bucket is exhausted.
          cursor: listed.truncated ? (listed.cursor ?? null) : null,
        };
      },
      // PREFIX FENCE — only ever delete an exact `org/{uuid}/ep/{uuid}/{hash}` object.
      validKey: (key) => isWellFormedPayloadKey(key),
      existingKeys: (keys) => existingPayloadKeys(sql, keys),
      deleteR2: (keys) => env.R2_PAYLOADS.delete(keys),
      // COUNT-ONLY by default — an irreversible cross-org R2 delete only runs once ORPHAN_SWEEP_DELETE=true
      // is set, after the count-only passes have been eyeballed. The pure, unit-tested parse fail-safes to
      // count-only for anything but "true".
      deleteEnabled: parseOrphanSweepDelete(env.ORPHAN_SWEEP_DELETE),
      writeCursor: (cursor) =>
        cursor === null
          ? env.KV_CONFIG.delete(ORPHAN_SWEEP_CURSOR_KEY)
          : env.KV_CONFIG.put(ORPHAN_SWEEP_CURSOR_KEY, cursor),
      now: Date.now(),
      safetyWindowMs: ORPHAN_SWEEP_SAFETY_WINDOW_MS,
      pageSize: ORPHAN_SWEEP_PAGE_SIZE,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    });
  } finally {
    await sql.end();
  }
}
