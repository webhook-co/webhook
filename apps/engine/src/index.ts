import { authorizeBearer, type BearerAuthzDeps } from "@webhook-co/contract";
import {
  createClient,
  createCredentialHasherFromBase64,
  createCredentialResolver,
  createIngestResolver,
  CREDENTIAL_CACHE_TTL_SECONDS,
  getEndpoint,
  insertIngestEvent,
  makeApiKeyColdLookup,
  makeVerifyBearer,
  readAuditChainHeads,
  withTenant,
  type ResolvedPrincipal,
} from "@webhook-co/db";
import {
  AwsKmsProvider,
  b64ToBytes,
  importAuditKey,
  type KmsProvider,
  MAX_VERIFIABLE_BODY_BYTES,
  OrgScopedDekCache,
  parseSince,
  readSecretBinding,
  SecretStore,
  SERVICE_NAME,
} from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { runAnchorCron } from "./anchor-cron";
import {
  handleIngest,
  type IngestDeps,
  type ResolvedEndpoint,
  type VerificationOutcome,
  type VerifyIngestInput,
} from "./ingest";
import { makeVerifyIngest } from "./verify";

// The per-session listen-tunnel Durable Object (Slice 11b, ADR-0014); wrangler binds it via
// LISTEN_SESSION. Re-exported here so the class is registered on the engine Worker entrypoint.
export { ListenSession, POLL_INTERVAL_MS } from "./listen-session";

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
  /** R2 bucket holding the WORM head anchors (retention-locked; this writer has no delete rights). */
  R2_AUDIT_ANCHOR: R2Bucket;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with (shared across surfaces). */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
  /** Per-session hibernatable listen-tunnel Durable Objects (Slice 11b, ADR-0014). */
  LISTEN_SESSION: DurableObjectNamespace;
  /** KV caching resolved principals for the tunnel bearer chain (mirrors apps/api KV_AUTHZ). */
  KV_AUTHZ: KVNamespace;
  /** Base64 HMAC key for opaque pagination cursors — must equal apps/api CURSOR_KEY (shared secret). */
  CURSOR_KEY: SecretsStoreSecret;
}

/**
 * content_hash dedup-bucket width. 24h ≥ the documented provider retry windows we bucket against
 * (so a redelivery inside the window collapses; a legitimately-identical body in a later bucket
 * does not). Only used by the content_hash fallback strategy.
 */
const DEDUP_BUCKET_WIDTH_MS = 24 * 60 * 60 * 1000;

// Isolate-scoped DEK handle cache (ADR-0007): unwrapped, non-extractable CryptoKey handles, bounded
// and org-scoped, reused across requests in this isolate so the KMS unwrap is amortized off the hot
// path. The verify function (KMS provider + SecretStore + adapter loop) is likewise built once per
// isolate, lazily on first verify.
const DEK_CACHE = new OrgScopedDekCache({ maxEntries: 256 });
export type VerifyFn = (input: VerifyIngestInput) => Promise<VerificationOutcome>;
let verifyFnPromise: Promise<VerifyFn> | undefined;

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
  return makeVerifyIngest(store, now, (event, fields) =>
    console.log(JSON.stringify({ message: event, ...fields })),
  );
}

/**
 * Lazily build the per-isolate verify function over the AWS KMS custodian. Memoized so the provider +
 * SecretStore construction happens once per isolate. A REJECTED init (incomplete KMS config) is NOT
 * cached: the memo is cleared so a later request retries rather than the isolate being poisoned for
 * its lifetime (handleIngest's verify guard still degrades a failing build to verified=false, never
 * blocking capture).
 */
export function getVerifyFn(env: Env): Promise<VerifyFn> {
  if (verifyFnPromise === undefined) {
    verifyFnPromise = (async () => buildVerifyFn(await kmsProviderFromEnv(env)))().catch(
      (err: unknown) => {
        verifyFnPromise = undefined; // don't cache a failed init — let the next request retry
        throw err;
      },
    );
  }
  return verifyFnPromise;
}

/** Per-request ingest deps plus the teardown for the DB clients they hold. */
export interface IngestDepsHandle {
  readonly deps: IngestDeps;
  /** Close the per-request DB clients (call in a finally — even on a thrown handler error). */
  close(): Promise<void>;
}

/** Build the per-request ingest deps. Injected in tests so routing is exercised without a live DB. */
export type MakeIngestDeps = (env: Env) => Promise<IngestDepsHandle>;

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
  };
}

/**
 * Construct the live ingest deps from the Worker bindings: a KV-cached endpoint resolver over the
 * webhook_authn cold lookup, an R2 PUT, and the webhook_ingest insert. Two SHORT-LIVED clients per
 * request (one per role), torn down by close(). The pepper is decoded in-worker (a Workers secret,
 * never a process env) and createCredentialHasher validates its length.
 */
export async function buildIngestDeps(env: Env): Promise<IngestDepsHandle> {
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
    now: () => new Date(),
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
    maxBodyBytes: MAX_VERIFIABLE_BODY_BYTES,
    dedupBucketWidthMs: DEDUP_BUCKET_WIDTH_MS,
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
// audience — existing api keys tunnel unchanged (ADR-0014). MUST match apps/api's API_RESOURCE.
export const API_RESOURCE = "https://api.webhook.co";
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

/**
 * Construct the listen-upgrade deps from the bindings: the api-key bearer chain (mirrors apps/api — a
 * KV-cached resolver over the webhook_authn cold lookup, audience-bound to API_RESOURCE) plus a
 * short-lived tenant client for the endpoint existence guard. Both clients torn down by close().
 */
export async function buildListenAuth(env: Env): Promise<ListenAuthHandle> {
  const hasher = createCredentialHasherFromBase64(await readSecretBinding(env.CREDENTIAL_PEPPER));
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
  const resolver = createCredentialResolver({
    hasher,
    cache: kvCredentialCache(env.KV_AUTHZ),
    coldLookup: makeApiKeyColdLookup(authn, API_RESOURCE),
    // The tunnel bearer reuses the api audience; stamp it (KV_AUTHZ is shared with api/mcp).
    resource: API_RESOURCE,
  });
  return {
    authDeps: {
      verifyBearer: makeVerifyBearer(resolver),
      resource: API_RESOURCE,
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
): Promise<Response> {
  const url = new URL(request.url);
  const handle = await makeAuth(env);
  try {
    const authz = await authorizeBearer(
      handle.authDeps,
      request.headers.get("authorization"),
      "events.tail",
    );
    if (!authz.ok) {
      // 401 (no/invalid/misdirected credential) or 403 (under-scoped) — no socket, RFC 6750 challenge.
      return new Response(null, {
        status: authz.status,
        headers: { "www-authenticate": authz.challenge },
      });
    }

    const endpointId = url.searchParams.get("endpointId");
    if (!endpointId || !UUID_RE.test(endpointId)) {
      return new Response("invalid or missing endpointId", { status: 400 });
    }
    // Existence guard under the bearer-derived org's RLS: a cross-org or unknown id is NOT_FOUND
    // (and indistinguishable — a caller can't probe another org's endpoints).
    if (!(await handle.endpointExists(authz.ctx.orgId, endpointId))) {
      return new Response("endpoint not found", { status: 404 });
    }

    // Per-session DO: a fresh id on first connect, or the client's id on reconnect (sticky resume).
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const stub = env.LISTEN_SESSION.get(env.LISTEN_SESSION.idFromName(sessionId));

    // Forward the upgrade with the binding on trusted headers, overwriting any client-supplied ones.
    const headers = new Headers(request.headers);
    headers.set("x-listen-org-id", authz.ctx.orgId);
    headers.set("x-listen-endpoint-id", endpointId);
    headers.set("x-listen-session-id", sessionId);
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

/**
 * The wbhk.my router. GET / is the ONLY liveness probe; the /listen WebSocket upgrade is the CLI
 * tunnel; every other request is the ingest write path (handleIngest enforces POST + the rest). Owns
 * per-request DB-client lifecycle: build deps, delegate, and close() in a finally so a thrown handler
 * error never leaks a connection.
 */
export async function handleFetch(
  request: Request,
  env: Env,
  makeDeps: MakeIngestDeps = buildIngestDeps,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(`${SERVICE_NAME}:engine ok`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // The CLI listen tunnel: a bearer-authed WebSocket upgrade (separate auth/deps from ingest).
  if (url.pathname === "/listen") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    return handleListenUpgrade(request, env);
  }

  const handle = await makeDeps(env);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Catch + log here so a config error (bad secret/binding) or a DB outage surfaces in
    // observability rather than as a silent unhandled rejection inside waitUntil.
    ctx.waitUntil(
      runAuditAnchorCron(env).catch((err: unknown) =>
        console.log(JSON.stringify({ message: "audit anchor cron failed", error: String(err) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

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
