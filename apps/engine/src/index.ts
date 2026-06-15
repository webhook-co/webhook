import {
  createClient,
  createCredentialHasherFromBase64,
  createIngestResolver,
  CREDENTIAL_CACHE_TTL_SECONDS,
  insertIngestEvent,
  readAuditChainHeads,
  type ResolvedPrincipal,
} from "@webhook-co/db";
import {
  b64ToBytes,
  importAuditKey,
  LocalKmsProvider,
  MAX_VERIFIABLE_BODY_BYTES,
  OrgScopedDekCache,
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
  /** Base64 credential pepper (Worker secret): keys the ingest-token HMAC. Never a DB column. */
  CREDENTIAL_PEPPER: string;
  /**
   * Base64 KEK (Worker secret) for the local KMS provider — unwraps the per-secret DEKs that seal
   * provider signing secrets (envelope.ts / ADR-0007). The dev/self-host custodian; AWS KMS swaps in
   * behind the same KmsProvider seam at the construction site. Never a DB column.
   */
  KEK: string;
  /** Hyperdrive config for the webhook_anchor cross-org head read (query caching off). */
  HYPERDRIVE_ANCHOR: Hyperdrive;
  /** R2 bucket holding the WORM head anchors (retention-locked; this writer has no delete rights). */
  R2_AUDIT_ANCHOR: R2Bucket;
  /** Base64 audit-chain HMAC key (Worker secret) — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: string;
}

/**
 * content_hash dedup-bucket width. 24h ≥ the documented provider retry windows we bucket against
 * (so a redelivery inside the window collapses; a legitimately-identical body in a later bucket
 * does not). Only used by the content_hash fallback strategy.
 */
const DEDUP_BUCKET_WIDTH_MS = 24 * 60 * 60 * 1000;

// Isolate-scoped DEK handle cache (ADR-0007): unwrapped, non-extractable CryptoKey handles, bounded
// and org-scoped, reused across requests in this isolate so the KMS unwrap is amortized off the hot
// path. The verify function (KEK import + SecretStore + adapter loop) is likewise built once per
// isolate, lazily on first verify.
const DEK_CACHE = new OrgScopedDekCache({ maxEntries: 256 });
type VerifyFn = (input: VerifyIngestInput) => Promise<VerificationOutcome>;
let verifyFnPromise: Promise<VerifyFn> | undefined;

/**
 * Lazily build the per-isolate verify function from the KEK secret (LocalKmsProvider — the
 * dev/self-host custodian behind the KmsProvider seam; AWS KMS swaps in later). Memoized so the KEK
 * import + SecretStore happen once per isolate. A REJECTED init (bad/missing KEK) is NOT cached: the
 * memo is cleared so a later request retries rather than the isolate being poisoned for its lifetime
 * (handleIngest's verify guard still degrades a failing build to verified=false, never blocking
 * capture).
 */
function getVerifyFn(env: Env): Promise<VerifyFn> {
  if (verifyFnPromise === undefined) {
    verifyFnPromise = (async () => {
      // b64ToBytes uses the Workers `atob` global (no Buffer in the worker type env) and throws on
      // non-base64. LocalKmsProvider.fromRawKek enforces the 32-byte length.
      const kms = await LocalKmsProvider.fromRawKek(b64ToBytes(env.KEK));
      const store = new SecretStore(kms, DEK_CACHE);
      return makeVerifyIngest(
        store,
        () => new Date(),
        (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
      );
    })().catch((err: unknown) => {
      verifyFnPromise = undefined; // don't cache a failed init — let the next request retry
      throw err;
    });
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
export type MakeIngestDeps = (env: Env) => IngestDepsHandle;

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
export function buildIngestDeps(env: Env): IngestDepsHandle {
  const hasher = createCredentialHasherFromBase64(env.CREDENTIAL_PEPPER);
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

/**
 * The wbhk.my router. GET / is the ONLY liveness probe; every other request is the ingest write
 * path (handleIngest enforces POST + the rest). Owns per-request DB-client lifecycle: build deps,
 * delegate, and close() in a finally so a thrown handler error never leaks a connection.
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

  const handle = makeDeps(env);
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
  const raw = b64ToBytes(env.AUDIT_CHAIN_HMAC_KEY);
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
