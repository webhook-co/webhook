import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AnyCapability, AuthContext } from "@webhook-co/contract";
import {
  buildCapabilityHandlers,
  createClient,
  createCredentialHasherFromBase64,
  makeIngestHashEvictor,
  type CredentialHasher,
} from "@webhook-co/db";
import {
  b64ToBytes,
  importAuditKey,
  importCursorKey,
  parseFreeEventCap,
  readSecretBinding,
} from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";
// A VALUE import: whoami declares an explicit strict empty input (see its registration below).
import { z } from "zod";

import { MCP_BOUND_CAPABILITIES } from "./bound-capabilities";
import { grantPropsToAuthContext } from "./grant";
import { genericToolError, runCapabilityTool, type McpToolResult } from "./tools";
import { buildWhoami } from "./whoami";
import type { McpEnv } from "./env";

// The webhook.co MCP server as a Cloudflare Agent (Durable Object). It registers the read
// capabilities (MCP_BOUND_CAPABILITIES) as MCP tools, each binding the SHARED createReadHandlers
// map — the very same handlers apps/api dispatches over HTTP, so the two surfaces can't drift.
//
// Auth: the resource-server router (resource-handler.ts, A8) validates the bearer (a `whk_` api key via
// the credential chain, or an opaque OAuth token via introspection to auth.) and sets the resolved
// principal on the execution context, which the McpAgent surfaces as `this.props`; grantPropsToAuthContext
// re-validates that shape into an AuthContext at the trust boundary (grant.ts). Each tool then runs
// the shared handler under RLS with a per-call tenant client. NO fault is ever thrown out of a tool
// handler — the MCP SDK would echo the message to the client — so a malformed principal or an
// operational fault is logged and returned as a generic, leak-free error (see tools.ts). The
// cursor/audit HMAC keys are imported once per DO start (init).
//
// SESSION BINDING (security): the McpAgent Durable Object is keyed by the `Mcp-Session-Id`, and
// `this.props` is set ONCE — from the principal of the request that INITIALIZES the session (McpAgent
// `onStart`; warm requests don't refresh it). So a warm DO is pinned to its initializing principal. A8c
// closes cross-principal reuse at the resource-server EDGE (not in the DO): the session id handed to the
// client is an HMAC-signed envelope BOUND to that principal (resource-handler.ts + session-binding.ts), and
// every request must present a session id that unbinds to the SAME principal or it's rejected (404) before
// the transport routes the DO. So a reused/stolen session id can't reach another principal's DO — by the
// time a request reaches this tool handler, its principal already matches `this.props`. (Edge wrapping, not
// in-DO routing, because the streamable-HTTP handler routes purely by session id and surfaces no per-request
// principal to the DO. Was the ADR-0011 follow-up; see ADR-0035.)

const SERVER_NAME = "webhook.co";
// Kept in lockstep with `apps/mcp/server.json` (the MCP Registry manifest) by
// scripts/mcp-registry-guard.mjs: the registry listing and the version a client sees on
// `initialize` are the same string, so a listing can never advertise a version we don't serve.
const SERVER_VERSION = "1.0.0";
// Human-facing display name + description surfaced via the initialize serverInfo (SDK Implementation.title/
// description). Clients that render a server title/description prefer these over the programmatic `name`.
// (The connector-list ICON is client-drawn from its own registry and ignores serverInfo — a marketplace
// listing, not something we can set here.)
const SERVER_TITLE = "webhook.co";
const SERVER_DESCRIPTION =
  "Receive, inspect, replay, and deliver webhooks — manage endpoints, browse events, and wire up agent triggers.";
// Agent-facing description for the identity tool. Note the profile-scope gate so an agent knows why
// name/email may be absent.
const WHOAMI_DESCRIPTION =
  "Who am I? Returns the authenticated organization, user, and granted scopes. Includes the user's name and email only if the `profile` scope was granted at authorization.";

/**
 * Short human-facing display names, shown in tool pickers and required by the Connectors Directory
 * ("All tools must include a `title`"). Sentence case, per the brand voice.
 *
 * Hand-written because a title is display copy, not a derivable fact — but NOT optional: the
 * registration below throws on a missing one rather than falling back to the tool name, because a
 * fallback title is indistinguishable from a real one on the wire and would pass a presence check
 * while telling a user nothing. `mcp-tools.test.ts` asserts both, over the live tools/list response.
 */
const TOOL_TITLES: Record<string, string> = {
  "endpoints.list": "List endpoints",
  "endpoints.get": "Get endpoint",
  "endpoints.create": "Create endpoint",
  "endpoints.delete": "Delete endpoint",
  "endpoints.rotate": "Rotate ingest URL",
  "endpoints.update": "Update endpoint",
  "endpoints.revealIngestUrl": "Reveal ingest URL (bearer credential)",
  "endpoints.addProviderSecret": "Add provider signing secret",
  "endpoints.listProviderSecrets": "List provider signing secrets",
  "endpoints.revokeProviderSecret": "Revoke provider signing secret",
  "events.list": "List events",
  "events.get": "Get event",
  "events.tail": "Tail events",
  "events.delete": "Delete event",
  "deliveries.list": "List deliveries",
  "deliveries.get": "Get delivery",
  "triggers.create": "Create agent trigger",
  "triggers.list": "List agent triggers",
  "triggers.revoke": "Revoke agent trigger",
  "triggers.wait": "Wait for triggered events",
  "audit.verify": "Verify audit chain",
  "usage.get": "Get usage",
};

const WHOAMI_TITLE = "Who am I";

/** Concise, agent-facing descriptions for the bound read tools (MCP tool discovery). */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "endpoints.list":
    "List the org's webhook endpoints (paginated). Optional `filter.name` does a case-insensitive substring match on the endpoint name.",
  "endpoints.get": "Get a single webhook endpoint by id.",
  "endpoints.create":
    "Create a webhook endpoint and return its ingest URL. The URL contains a secret token, so treat it as a credential — but it is NOT one-time: it can be re-read any time with endpoints.revealIngestUrl (or in the dashboard), so never tell the user this is their only chance to save it.",
  "endpoints.delete":
    "DESTRUCTIVE: permanently soft-delete a webhook endpoint by id. Its ingest URL stops accepting new events and it is removed from listings; captured events are retained but the endpoint can no longer receive new ones. Confirm with the user before calling.",
  "endpoints.rotate":
    "DESTRUCTIVE: rotate a webhook endpoint's ingest URL by id — mints a NEW URL and revokes the old one. Use it for a LEAKED URL: a merely forgotten one can be re-read with endpoints.revealIngestUrl instead, with no rotation and no downtime. The endpoint id, name, and captured events are kept, but the old URL stops accepting events immediately, so any sender still posting to it breaks until repointed. The new URL is a credential but is NOT one-time — it stays re-readable. Confirm with the user before calling.",
  "endpoints.revealIngestUrl":
    "Reveal a webhook endpoint's current ingest URL by id (non-destructive — it does NOT rotate). This is the right tool when a user has lost or forgotten their ingest URL. The URL is a bearer credential, so this is treated like a write: it is audited. Returns `ingestUrl: null` only for endpoints created before sealed storage (their URL is genuinely unrecoverable — rotate to mint a fresh always-readable one).",
  "events.list":
    "List received events across the whole org (paginated, newest-first) — OR pass `endpointId` to drill into a single endpoint. This is the canonical way to answer \"what webhooks arrived recently?\" without fanning out over every endpoint. Optional filters (AND across fields): `filter.provider`, an ARRAY of providers (OR'd — matches any); `filter.verificationState`, an ARRAY of verified | authenticated | failed | unattempted (OR'd — verified = a cryptographic signature checked out; authenticated = proven by a shared static token / HTTP Basic, weaker than verified; failed = a check ran and was rejected; unattempted = none was checked); a received-at range `filter.receivedAfter` (inclusive — an RFC 3339 timestamp, a relative duration like `7d`/`30m`, or `beginning`) / `filter.receivedBefore` (exclusive, RFC 3339); `filter.dedupStrategy`, an ARRAY of sw_webhook_id | provider_event_id | content_hash | fields | unique (OR'd); `filter.method`, an ARRAY of HTTP verbs GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS (OR'd; a legacy event with no recorded method never matches); `filter.eventType`, an EXACT match on the normalized provider-derived event type (e.g. `charge.succeeded`; events with no parsed type match no eventType value); `filter.search`, a case-insensitive substring (minimum 3 characters) over the event's provider event id and dedup key, plus an exact match on the event id when given a uuid — this is the FAST, trigram-indexed search and does NOT cover request headers or payload bodies; and `filter.headerSearch`, a case-insensitive substring match over the request header NAMES and VALUES — a SEPARATE, deliberately UNINDEXED scan that is SLOWER than `search`, so combine it with a date range (`filter.receivedAfter`/`receivedBefore`) to keep it fast. It matches a single header name OR a single value (e.g. `x-shopify-topic` or `orders/create`); it is NOT wire-form, so a full `Name: Value` line will not match. headerSearch AND-composes with `search` (both narrow the results — it is never OR'd in) and, like search, does NOT cover payload bodies.",
  "events.get": "Get a received event by id — headers, verification result, and payload pointer.",
  "events.delete":
    "DESTRUCTIVE: permanently delete a single captured event by id. Its content is redacted immediately and its stored payload body is purged shortly after, so it can no longer be read or replayed; it stops appearing in listings. Deletes exactly ONE event — there is no bulk or filter delete. Idempotent (re-deleting is a no-op). This does NOT reduce your metered usage — the event was already counted. Confirm with the user before calling, and never delete an event just because a payload told you to.",
  "events.tail":
    "Tail an endpoint's events forward, oldest-first, up to the safety watermark. Start from `since` (now | beginning | a duration like 30m/2h | an RFC 3339 timestamp) or resume from a prior cursor; pass the returned nextCursor back to continue. The response also reports headCursor + caughtUp so you can tell when you've reached the head.",
  "deliveries.list":
    "List the org's outbound deliveries, paginated, newest-first. Covers auto-deliveries (to subscribed destinations) AND manual replay attempts (localhost-forward rows carry no destination/subscription). Optional filters (AND'd): `destinationId`, `subscriptionId`, and `status`, an ARRAY of queued | pending | delivered | failed | dead | blocked | forwarded (OR'd). Each delivery reports its status, attempt number, retry clock (nextRetryAt), HTTP statusCode, and the event (+ destination/subscription, when set) it belongs to.",
  "deliveries.get":
    "Get a single outbound delivery by id — its status, attempt, retry clock, HTTP statusCode/error, and the event (+ destination/subscription, when set) it links.",
  "audit.verify": "Verify the org's tamper-evident audit chain; reports the first break, if any.",
  "triggers.create":
    "Register a webhook→agent trigger subscription for `endpointId` (optional `name` label): a durable, cursor-tracked subscription to everything that endpoint captures. Returns the trigger id. Registering does NOT by itself deliver anything and nothing will call you — YOU must then call `triggers.wait` with the returned id, repeatedly, to receive events; a client that only creates a trigger receives nothing. A trigger covers the WHOLE endpoint and takes no event-type filter. Creates NO outbound delivery — it only subscribes you to events the org can already read.",
  "triggers.list":
    "List the org's active agent trigger subscriptions (optional `endpointId` filter). Each item is a trigger id + its endpoint, name, and created time.",
  "triggers.revoke":
    "Revoke an agent trigger subscription by id — subsequent `triggers.wait` calls for it fail with NOT_FOUND. Idempotent: revoking an already-revoked trigger succeeds.",
  "usage.get":
    "Get the org's metering usage — events used, included cap, and pause state. A billed EVENT is one captured request to an endpoint OR one delivery to a destination; retries never count. `capKind` says what the cap is measured over: `billing_cycle` (a paid plan's per-cycle volume, between periodStart and periodEnd) or `lifetime` (the Free tier's ONE-TIME allowance, counted since periodStart and never reset — periodEnd is null).",
  "triggers.wait":
    "Consume the next webhook→agent events for a trigger subscription (by triggerId). Returns { events, nextCursor, caughtUp }: `events` are new events oldest-first (each with its verification state + `vouched` — true only when we authenticated the source; forged/rejected events are NEVER returned); pass `nextCursor` back to continue. Re-call promptly while `caughtUp` is false to drain a backlog, then poll on your own cadence once caught up. At-least-once: a crash before you persist nextCursor just re-delivers (dedup on the event id). Optional `cursor` (resume) and `limit`.",
  "endpoints.addProviderSecret":
    "Register an inbound-verification secret on an endpoint. `kind` is `signing_secret` (default — the provider's signing/auth secret, so received webhooks are cryptographically verified) or `verify_token` (a user-chosen GET-handshake compare-token, e.g. Meta's hub.verify_token, used to complete a subscription verification). Provide `provider`, the plaintext `secret`, and optional `kind`/`label`; it is sealed server-side and NEVER returned. Treat the secret as sensitive — confirm with the user before storing one on their behalf.",
  "endpoints.listProviderSecrets":
    "List an endpoint's provider signing secrets as metadata (id, provider, status, label, created) — never the secret values.",
  "endpoints.revokeProviderSecret":
    "Revoke a provider signing secret by id on an endpoint. Inbound webhooks signed with it stop verifying immediately. Confirm with the user before calling.",
};

/**
 * Every capability input is a `z.object` (a contract invariant), and the WHOLE schema is advertised
 * as the tool's parameter schema — not its `.shape`. The distinction is the point: capability inputs
 * are strict, and `z.toJSONSchema(input, { io: "input" })` only emits `additionalProperties: false`
 * for the schema itself. Handing over the bare shape drops that, and an agent inventing a plausible
 * sibling field (`eventTypes`, which is real on `subscriptions.create`) would see nothing forbidding
 * it — discovery is exactly where a model makes the decision.
 *
 * This also MOVES the rejection. The SDK validates arguments against whatever schema it was given
 * before it calls the handler, and it previously wrapped the bare `.shape` in a non-strict object, so
 * unknown keys were stripped and the shared handler's own `safeParse` was the first thing to see
 * them. Handing over the real schema makes the SDK the first and only gate for this class: it answers
 * a JSON-RPC `-32602` InvalidParams, NOT the `{"error":"VALIDATION_ERROR"}` envelope
 * `apps/mcp/src/tools.ts` builds. That is a deliberate trade — an earlier, stricter rejection with
 * the offending key named, at the cost of this one error class not carrying a capability error code
 * on mcp. The two `.superRefine` inputs move with it, for the same reason.
 */
function inputSchema(cap: AnyCapability): z.ZodTypeAny {
  return cap.input;
}

/**
 * The display name, or a hard failure.
 *
 * No `?? cap.name` fallback, deliberately — that is what `TOOL_DESCRIPTIONS` does, and it means a
 * forgotten entry ships as a title that LOOKS present to any presence check while telling a user
 * nothing. Throwing at registration turns "someone added a capability and forgot the copy" into a
 * failing boot in CI instead of a silently degraded listing.
 */
function toolTitle(cap: AnyCapability): string {
  const title = TOOL_TITLES[cap.name];
  if (title === undefined || title.trim() === "") {
    throw new Error(`mcp: no TOOL_TITLES entry for "${cap.name}" — add one before binding it`);
  }
  return title;
}

/**
 * MCP tool annotations, DERIVED from the capability contract rather than restated here.
 *
 * The Connectors Directory requires a `title` plus the applicable `readOnlyHint`/`destructiveHint`,
 * and a second hand-maintained list of which tools are read-only would drift from the scopes that
 * actually gate them. So:
 *   • `readOnlyHint` ← the auth scope. `:read` is read-only; `endpoints:write`, `events:replay`,
 *     `events:delete` and `triggers:write` are not.
 *   • `destructiveHint` ← `semantics.destructive`, which `parity.test.ts` requires every write
 *     capability to declare. Only emitted for writes: the hint is meaningless when `readOnlyHint`
 *     is true, and the MCP default of `true` is why silence is not an option for a write.
 *   • `idempotentHint` ← `semantics.idempotent`. Same gate as `destructiveHint`, for the same
 *     spec reason — it is defined only when `readOnlyHint` is false.
 *
 * CAVEAT on the first bullet, because it is the load-bearing one: a scope governs AUTHORIZATION, not
 * mutation, and nothing structurally stops a `:read` capability from writing. `readOnlyHint: true` is
 * what a client may use to auto-approve without prompting, so the mapping is only as good as the
 * handlers. Verified handler-by-handler as of this change: all 12 read-scoped bound capabilities are
 * pure selects under `withTenant` — `triggers.wait` included, whose ack is a caller-held cursor, not a
 * server-side write. Re-check when adding a capability; the guard cannot see this for you.
 *
 * `openWorldHint` is left at its MCP default (`true`) — deliberately undecided, not decided closed.
 * The directory does not require it, and a per-tool judgement on whether third-party payloads make
 * `events.*` "open world" is a separate call from this change.
 */
function toolAnnotations(cap: AnyCapability): {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
} {
  const readOnly = cap.auth.scope.endsWith(":read");
  return {
    readOnlyHint: readOnly,
    ...(readOnly
      ? {}
      : {
          destructiveHint: cap.semantics.destructive === true,
          ...(cap.semantics.idempotent === undefined
            ? {}
            : { idempotentHint: cap.semantics.idempotent }),
        }),
  };
}

export class WebhookMcp extends McpAgent<McpEnv> {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: SERVER_TITLE,
    description: SERVER_DESCRIPTION,
  });

  // Imported once per DO start in init() (before any tool call runs), so the per-call path opens
  // only a tenant DB client. Definite-assignment: init() always sets these before tools dispatch.
  private cursorKey!: CryptoKey;
  private auditKey!: CryptoKey;
  // The credential hasher (CREDENTIAL_PEPPER) — needed by the WRITE handlers (endpoints.create mints
  // an ingest token inside the DO). Reads never use it; built once in init() like the keys above.
  private hasher!: CredentialHasher;

  /** Structured observability log (mirrors the engine/api `console.log(JSON…)` convention). */
  private log(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ message: event, ...fields }));
  }

  async init(): Promise<void> {
    const [pepper, cursorRaw, auditRaw] = await Promise.all([
      readSecretBinding(this.env.CREDENTIAL_PEPPER),
      readSecretBinding(this.env.CURSOR_KEY),
      readSecretBinding(this.env.AUDIT_CHAIN_HMAC_KEY),
    ]);
    this.hasher = createCredentialHasherFromBase64(pepper);
    [this.cursorKey, this.auditKey] = await Promise.all([
      importCursorKey(b64ToBytes(cursorRaw)),
      importAuditKey(b64ToBytes(auditRaw)),
    ]);

    for (const cap of MCP_BOUND_CAPABILITIES) {
      this.server.registerTool(
        cap.name,
        {
          title: toolTitle(cap),
          description: TOOL_DESCRIPTIONS[cap.name] ?? cap.name,
          inputSchema: inputSchema(cap),
          annotations: toolAnnotations(cap),
        },
        async (args: unknown) => {
          const result = await this.runTool(cap.name, args);
          // The single point where an McpToolResult becomes the SDK's (mutable) CallToolResult.
          return {
            content: result.content.map((c) => ({ type: c.type, text: c.text })),
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );
    }

    // whoami — identity, NOT a capability (binds no resource), so registered outside the capability loop.
    // Returns org/user/scopes always; name+email only when the token carries the consented `profile` scope,
    // resolved on-demand via the auth. RPC (kept off the introspection hot path).
    // Deliberately NOT strict, unlike every capability tool. whoami takes no arguments, so there is no
    // field to misspell and strictness protects nothing — while its only reachable effect is to reject
    // a client that sends a placeholder argument for a no-parameter tool, which real MCP clients do.
    // whoami is the canonical "is my connection working" call, so that failure would land on the first
    // thing a new user runs, to buy nothing but symmetry.
    // Annotated by hand because it is not a capability: it reads the authenticated principal and
    // nothing else. No `idempotentHint` — the spec defines it only when `readOnlyHint` is false, the
    // same rule this file enforces for `destructiveHint`.
    this.server.registerTool(
      "whoami",
      {
        title: WHOAMI_TITLE,
        description: WHOAMI_DESCRIPTION,
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        let ctx: AuthContext;
        try {
          ctx = grantPropsToAuthContext(this.props);
        } catch (err) {
          this.log("mcp.malformed_grant", { error: String(err) });
          const err0 = genericToolError();
          return {
            content: err0.content.map((c) => ({ type: c.type, text: c.text })),
            isError: true,
          };
        }
        const issuer = this.env.AUTH_ISSUER;
        // The bound org's {id,slug,name} is resolved on auth. over the AUTH_ISSUER binding (like
        // resolveProfile), so the DB read stays OFF this worker. The binding is absent in local dev / preview
        // (no `services` block) — pass NO resolver then, so buildWhoami skips the org read entirely (no error,
        // no log for the expected no-op). buildWhoami owns the timeout + validation + fault logging.
        const resolveOrg = issuer?.resolveOrgIdentity
          ? (orgId: string) => issuer.resolveOrgIdentity(orgId)
          : undefined;
        const result = await buildWhoami(
          ctx,
          async (userId) => {
            try {
              return await this.env.AUTH_ISSUER.resolveProfile(userId);
            } catch (err) {
              // Degrade to base identity (buildWhoami reads null as "not found"), but leave a non-PII
              // breadcrumb — a persistent auth-RPC outage silently dropping name/email must be diagnosable.
              this.log("mcp.profile_resolve_failed", { error: String(err) });
              return null;
            }
          },
          resolveOrg,
          (event, fields) => this.log(event, fields ?? {}),
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  /** Resolve the grant, run the capability under a per-call tenant client, map every outcome. */
  private async runTool(capabilityName: string, args: unknown): Promise<McpToolResult> {
    let ctx: AuthContext;
    try {
      // The provider already authenticated the token; a malformed grant is a server-side integrity
      // event (a poisoned store or a mint-shape bug). Fail closed with a GENERIC error — the props
      // carry no secret/PII, but we never echo the shape-validation detail to the client — and log it.
      ctx = grantPropsToAuthContext(this.props);
    } catch (err) {
      this.log("mcp.malformed_grant", { error: String(err) });
      return genericToolError();
    }
    // A short-lived RLS-scoped tenant client per call, torn down in finally — never leak a pooled
    // connection (mirrors apps/api + apps/engine). Caching is off on this binding.
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      // The merged read+write capability-handler map, single-sourced in @webhook-co/db (the same map
      // apps/api builds, so the surfaces can't drift). This is load-bearing: endpoints.create
      // auto-registers as a tool (MCP_BOUND_CAPABILITIES), so without the write handlers a call would
      // fall through to the no-handler path. The write handlers mint inside this DO (this.hasher) and
      // validate INGEST_BASE_URL lazily + fail-closed at create time.
      const handlers = buildCapabilityHandlers({
        tenant,
        cursorKey: this.cursorKey,
        auditKey: this.auditKey,
        hasher: this.hasher,
        ingestBaseUrl: this.env.INGEST_BASE_URL,
        // endpoints.delete / endpoints.rotate tools evict the token's hot entry from the engine's ingest
        // cache (ADR-0076). Best-effort: the deleted_at filter + rotated-hash mismatch self-heal within
        // the KV TTL, so a KV blip is logged, never thrown (a throw would lose the rotate URL reveal).
        invalidateIngestHash: makeIngestHashEvictor(kvCredentialCache(this.env.KV_CONFIG), (err) =>
          this.log("mcp.ingest_evict_failed", { error: String(err) }),
        ),
        // endpoints.addProviderSecret tool seals via the engine (the McpAgent never holds the KEK — D1).
        secretSealer: this.env.PROVIDER_SECRET_SEALER,
        // endpoints.revealIngestUrl unseals the always-shown ingest URL via the engine (KEK stays there).
        revealIngestUrl: this.env.INGEST_URL_REVEALER,
        // triggers.wait fetches the bounded inline body via the engine (the McpAgent has no R2 binding).
        payloadReader: this.env.PAYLOAD_READER,
        // usage.get shows a rowless (Free) org the cap it is enforced at (S4.3b) — same FREE_EVENT_CAP
        // the engine cap producer uses. Unset/invalid → null (uncapped, fail-safe).
        defaultEventCap: parseFreeEventCap(this.env.FREE_EVENT_CAP),
      });
      return await runCapabilityTool(handlers, capabilityName, ctx, args, (event, fields) =>
        this.log(event, fields),
      );
    } finally {
      await tenant.end();
    }
  }
}
