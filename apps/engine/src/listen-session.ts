import { DurableObject } from "cloudflare:workers";

import {
  createClient,
  resolveSince,
  tailEventsWithCursors,
  tailMeta,
  withTenant,
  type ItemWithCursor,
  type Page,
} from "@webhook-co/db";
import {
  b64ToBytes,
  decodeCursor,
  encodeCursor,
  encodeServerFrame,
  importCursorKey,
  parseClientFrame,
  parseSince,
  readSecretBinding,
  WATERMARK_DELTA_MS,
  type Cursor,
  type EventSummary,
  type Since,
} from "@webhook-co/shared";

/**
 * Poll cadence for the watermark-bounded tail scan (ADR-0014). The gapless watermark (δ=5s) already
 * floors delivery latency, so polling faster than ~δ is wasted precision; 2s halves the steady-state
 * read load and DO wake frequency vs 1s for ~1s of extra worst-case latency that's imperceptible
 * against the 5s floor. Tunable.
 */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Max pages drained per poll (each page ≤ the keyset limit, ~50 events). Bounds the inline backlog
 * flush on connect and each alarm so a sizeable backlog catches up quickly (several pages per poll)
 * without an unbounded scan blocking the upgrade handshake or a single alarm invocation.
 */
const MAX_PAGES_PER_POLL = 10;

/**
 * Drain successive keyset pages from `readPage`, oldest-first, following `nextCursor` until the tail
 * is exhausted or `maxPages` is hit (the bound on the inline connect flush + each alarm, so a sizeable
 * backlog catches up over a few pages without an unbounded scan). Pure over the page reader, so the
 * multi-page catch-up is unit-tested without a live Postgres.
 */
export async function drainPages<T>(
  readPage: (resume: Cursor | undefined) => Promise<Page<T>>,
  resume: Cursor | undefined,
  maxPages: number = MAX_PAGES_PER_POLL,
): Promise<{ events: T[]; caughtUp: boolean }> {
  const events: T[] = [];
  let cursor = resume;
  // caughtUp = the drain reached the END of the watermark-bounded tail (a page returned a null
  // nextCursor) rather than stopping at maxPages with a backlog still pending. Derived from the
  // exit reason — NEVER from the item count (a full last page can still be exactly at the head).
  let caughtUp = false;
  for (let page = 0; page < maxPages; page++) {
    const result = await readPage(cursor);
    events.push(...result.items);
    if (result.nextCursor === null) {
      caughtUp = true;
      break;
    }
    cursor = result.nextCursor;
  }
  return { events, caughtUp };
}

/** The slice of the engine `Env` the listen-session DO needs (tenant reads + the cursor HMAC key). */
export interface ListenEnv {
  readonly HYPERDRIVE_TENANT: Hyperdrive;
  readonly CURSOR_KEY: SecretsStoreSecret;
}

/** Trusted upgrade-handler headers carrying the bearer-derived binding (never from a client frame). */
const HDR_ORG = "x-listen-org-id";
const HDR_ENDPOINT = "x-listen-endpoint-id";
const HDR_SESSION = "x-listen-session-id";
const HDR_SINCE = "x-listen-since-cursor";
/** `?since=<grammar>` (now|beginning|<duration>|<RFC3339>): resolved server-side to a boundary cursor. */
const HDR_SINCE_SPEC = "x-listen-since-spec";

/** The org/endpoint/session this DO is pinned to, persisted once on first connect. */
interface Binding {
  readonly orgId: string;
  readonly endpointId: string;
  readonly sessionId: string;
}

/** The durable resume position (last ACKed cursor). Stores the cursor's UTC ISO-µs `orderKey` verbatim (a
 *  plain string is JSON/structured-clone clean) so the resume keeps FULL microsecond precision — storing a
 *  ms epoch here would re-truncate the cursor and re-deliver same-ms events on resume. */
interface StoredCursor {
  readonly orderKey: string;
  readonly id: string;
}

/**
 * One hibernatable WebSocket Durable Object per `wbhk listen` session (Slice 11b, ADR-0014).
 *
 * Single-lane, poll-only: on a deterministic ~2s alarm it scans Neon for events at/below the gapless
 * watermark (`tailEvents`, watermark computed Postgres-side) under the bearer-derived org's RLS, and
 * pushes summary frames to the connected socket(s). There is NO push from ingest and NO active-session
 * registry — the watermark + opaque cursor are the source of truth; the alarm only decides *when* to
 * scan. The alarm composes with hibernation (a future-scheduled alarm doesn't pin the DO), and the
 * handler never throws (a thrown alarm would stop retrying and the tail would go silent).
 *
 * At-least-once: the DURABLE resume cursor advances only on `ack`; the in-memory "already streamed
 * this session" position (`lastSent`) is reset on every connect, so a reconnect re-delivers anything
 * the client hasn't acked. Consumers dedup by cursor/id.
 */
export class ListenSession extends DurableObject<ListenEnv> {
  private cursorKey!: CryptoKey;
  /** In-memory only: how far this *connection* has streamed. Reset on connect; lost on eviction. */
  private lastSent?: Cursor;
  /**
   * In-memory only: whether the last poll reached the watermark head. Gates the caught-up STATUS frame
   * so it fires once on the behind→caught-up transition, not every poll. Reset on connect; un-latches
   * on any not-caught-up poll so a later backlog re-arms the next transition.
   */
  private wasCaughtUp?: boolean;

  constructor(ctx: DurableObjectState, env: ListenEnv) {
    super(ctx, env);
    // Import the cursor HMAC key before any handler runs (re-runs on each hibernation wake).
    ctx.blockConcurrencyWhile(async () => {
      this.cursorKey = await importCursorKey(b64ToBytes(await readSecretBinding(env.CURSOR_KEY)));
    });
    // Protocol ping/pong is auto-answered without waking the DO — a hibernation-friendly keepalive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const orgId = request.headers.get(HDR_ORG);
    const endpointId = request.headers.get(HDR_ENDPOINT);
    const sessionId = request.headers.get(HDR_SESSION);
    if (!orgId || !endpointId || !sessionId) {
      // The trusted upgrade handler always sets these; a missing one is a wiring bug, not a client.
      return new Response("missing listen binding", { status: 400 });
    }

    // A session is pinned to its first (org, endpoint) binding. On reconnect, REFUSE a mismatched
    // binding: a reused sessionId pointed at another endpoint, or a stolen sessionId presented under
    // another org's bearer, must never stream the original binding's events. This is defense in depth
    // beyond the unguessable, server-minted session id; orgId/endpointId here are the trusted,
    // bearer-derived headers the upgrade handler set (re-authorized for the presented credential).
    const existing = await this.ctx.storage.get<Binding>("binding");
    if (existing) {
      if (existing.orgId !== orgId || existing.endpointId !== endpointId) {
        return new Response("session binding mismatch", { status: 403 });
      }
    } else {
      // Resolve the seed cursor BEFORE persisting the binding, so a load-bearing `--since` resolution
      // failure leaves NO binding behind — the CLI's retry re-enters first-bind and re-seeds, rather
      // than finding a half-bound session that silently starts from the oldest.
      let seed: Cursor | undefined;
      const sinceCursor = request.headers.get(HDR_SINCE);
      const sinceSpec = request.headers.get(HDR_SINCE_SPEC);
      if (sinceCursor) {
        // ?sinceCursor=: an opaque HMAC-signed resume cursor. A tampered/garbled one fails to decode →
        // start from the oldest (a conservative replay) — bad client input is NOT a load-bearing error.
        try {
          seed = await decodeCursor(sinceCursor, this.cursorKey);
        } catch {
          /* ignore an invalid initial cursor */
        }
      } else if (sinceSpec !== null) {
        // ?since=<grammar>: the upgrade handler already validated it; the DO re-parses authoritatively
        // and resolves it to a boundary cursor server-side (undefined = beginning / clamp-to-beginning
        // → leave the cursor unset = oldest-inclusive). Unlike the ADVISORY connect-status probe below,
        // this seed is LOAD-BEARING: a resolution error (a tenant-DB hiccup) FAILS the upgrade with 503
        // so the CLI retries — NEVER swallowed into an unset cursor, which would flood a `--since now`
        // session with the entire backlog (the opposite of what was asked).
        const parsed = parseSince(sinceSpec);
        if (parsed.kind === "invalid") {
          // The handler gates invalid specs; reaching here is a wiring bug. Fail closed, not oldest.
          return new Response("invalid --since spec", { status: 400 });
        }
        try {
          seed = await this.resolveSinceCursor(orgId, endpointId, parsed);
        } catch (err) {
          console.log(
            JSON.stringify({ message: "listen.since_resolve_failed", error: String(err) }),
          );
          return new Response("could not resolve --since position", { status: 503 });
        }
      }
      await this.ctx.storage.put<Binding>("binding", { orgId, endpointId, sessionId });
      if (seed) await this.persistCursor(seed);
    }

    // Reset the in-session stream position so the first alarm after THIS connect resumes from the
    // durable acked cursor — re-delivering anything un-acked (at-least-once across reconnects, even
    // when the DO is still resident).
    this.lastSent = undefined;
    this.wasCaughtUp = undefined;

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API (NOT server.accept()): the socket survives DO eviction. Tagged with the
    // sessionId so getWebSockets(tag) can address it; the binding lives in storage, not an attachment.
    this.ctx.acceptWebSocket(server, [sessionId]);
    server.send(
      encodeServerFrame({ type: "ready", sessionId, watermarkDeltaMs: WATERMARK_DELTA_MS }),
    );

    // Connect-time cursor-contract status (ADR-0017), first bind only: the initial caughtUp + the
    // capped backlog lag, from the seeded resume position — the resume-banner + backlog-guard signal a
    // client reads at session start. headCursor stays HTTP-only (the client tracks position from the
    // event-frame cursors). Reuses the same cache-disabled tenant binding under the bound org's RLS.
    if (!existing) {
      // The backlog probe is ADVISORY — a DB hiccup must never fail the WebSocket upgrade (mirrors the
      // poll's fail-safe posture). On error we skip the status frame and let the steady-state poll catch
      // the consumer up; the caught-up transition still fires later.
      try {
        const resume = this.toCursor(await this.ctx.storage.get<StoredCursor>("cursor"));
        const meta = await this.backlogMeta(orgId, endpointId, resume);
        const caughtUp = meta.backlogCount === 0;
        const headLagMs =
          meta.headCursor === null
            ? undefined
            : Math.max(0, Date.now() - new Date(meta.headCursor.orderKey).getTime());
        server.send(
          encodeServerFrame({
            type: "status",
            caughtUp,
            lag: {
              backlogCount: meta.backlogCount,
              ...(headLagMs !== undefined ? { headLagMs } : {}),
            },
          }),
        );
        this.wasCaughtUp = caughtUp;
      } catch (err) {
        console.log(
          JSON.stringify({ message: "listen.connect_status_degraded", error: String(err) }),
        );
      }
    }

    // Flush any backlog immediately on connect (inline, bounded by MAX_PAGES_PER_POLL), then schedule
    // the recurring poll. The alarm is scheduled one interval out — NOT immediately due: a now()-alarm
    // auto-fires before the next event loop turn, racing the reconnect/idle bookkeeping. Immediate
    // flush comes from this inline scan; the alarm only drives the steady-state tail.
    await this.runPoll();
    await this.armPoll();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    // No listeners → stop the loop without re-arming; a future connect re-arms it.
    if (this.ctx.getWebSockets().length === 0) return;
    await this.runPoll();
    await this.armPoll();
  }

  /** Schedule the next poll if none is pending (idempotent across reconnects + the inline flush). */
  private async armPoll(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  /**
   * Scan Neon for events past the resume position (in-session `lastSent`, else the durable acked
   * cursor) and broadcast a summary frame for each. MUST NOT throw (D5): a thrown alarm stops
   * retrying after ~6 attempts and the tail goes silent — so a poll failure becomes a recoverable
   * POLL_DEGRADED notice, never an escaping error.
   */
  private async runPoll(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const binding = await this.ctx.storage.get<Binding>("binding");
    if (!binding || sockets.length === 0) return;

    try {
      const resume =
        this.lastSent ?? this.toCursor(await this.ctx.storage.get<StoredCursor>("cursor"));
      const { events, caughtUp } = await this.pollEvents(binding, resume);
      for (const { item: summary, cursor: cur } of events) {
        // `cur` is the event's EXACT-µs cursor from the read — NOT rebuilt from summary.receivedAt (a ms Date).
        const frame = encodeServerFrame({
          type: "event",
          summary,
          cursor: await encodeCursor(cur, this.cursorKey),
        });
        for (const ws of sockets) this.safeSend(ws, frame);
        this.lastSent = cur;
      }
      // A STATUS frame ONLY on the behind→caught-up transition (not every poll): the connect frame
      // already carried the initial state, so we re-announce only when the tail newly reaches the head.
      if (caughtUp && this.wasCaughtUp !== true) {
        const status = encodeServerFrame({ type: "status", caughtUp: true });
        for (const ws of sockets) this.safeSend(ws, status);
      }
      this.wasCaughtUp = caughtUp;
    } catch (err) {
      console.log(JSON.stringify({ message: "listen.poll_degraded", error: String(err) }));
      const notice = encodeServerFrame({
        type: "error",
        code: "POLL_DEGRADED",
        message: "tail poll temporarily degraded",
      });
      for (const ws of sockets) this.safeSend(ws, notice);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const frame = parseClientFrame(message);
    if (!frame) {
      this.safeSend(
        ws,
        encodeServerFrame({ type: "error", code: "BAD_FRAME", message: "unrecognized frame" }),
      );
      return;
    }
    // Only `ack` today. Advance the DURABLE resume cursor on ack (at-least-once: un-acked events
    // re-deliver on reconnect). The cursor is HMAC-signed; a tampered one fails to verify → rejected.
    try {
      await this.persistCursor(await decodeCursor(frame.cursor, this.cursorKey));
    } catch {
      this.safeSend(
        ws,
        encodeServerFrame({
          type: "error",
          code: "BAD_CURSOR",
          message: "ack cursor failed to verify",
        }),
      );
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.stopIfIdle(ws);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.log(JSON.stringify({ message: "listen.ws_error", error: String(error) }));
    await this.stopIfIdle(ws);
  }

  /**
   * Drain events past `resume`, oldest-first, up to MAX_PAGES_PER_POLL pages, on ONE short-lived
   * RLS-scoped tenant client (a multi-page backlog reuses the same connection). Overridable in tests
   * (inject a canned reader; no live Postgres). Returns the drained batch + whether the drain reached
   * the watermark head (`caughtUp`) for the poll to broadcast + gate the status transition.
   */
  protected async pollEvents(
    binding: Binding,
    resume: Cursor | undefined,
  ): Promise<{ events: ItemWithCursor<EventSummary>[]; caughtUp: boolean }> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      // tailEventsWithCursors pairs each event with its EXACT-µs cursor — the tunnel emits a cursor per event
      // frame, so a client can ack any single event; the cursor must NOT be re-derived from the display Date.
      return await drainPages(
        (cursor) =>
          withTenant(tenant, binding.orgId, (tx) =>
            tailEventsWithCursors(tx, { endpointId: binding.endpointId, sinceCursor: cursor }),
          ),
        resume,
      );
    } finally {
      await tenant.end();
    }
  }

  /**
   * Resolve a validated `--since` spec to a boundary cursor for a fresh session's seed — the server-side
   * generalization of the old `?since=now` (now just `parseSince("now")` → the watermark head). One
   * short-lived RLS-scoped client under the bound org's RLS; `resolveSince` returns undefined for
   * `beginning`/clamp-to-beginning (seed unset = oldest-inclusive). Overridable in tests (inject a
   * canned cursor; no live Postgres).
   */
  protected async resolveSinceCursor(
    orgId: string,
    endpointId: string,
    since: Exclude<Since, { kind: "invalid" }>,
  ): Promise<Cursor | undefined> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      return await withTenant(tenant, orgId, (tx) => resolveSince(tx, { endpointId, since }));
    } finally {
      await tenant.end();
    }
  }

  /**
   * The watermark-bounded head + the capped backlog count for a seed/resume position — the cursor
   * contract's `lag` (ADR-0017) the connect-time STATUS frame carries. One short-lived RLS-scoped
   * client on the cache-disabled tenant binding (never a count cached across orgs). Overridable in
   * tests (inject a canned result; no live Postgres).
   */
  protected async backlogMeta(
    orgId: string,
    endpointId: string,
    resume: Cursor | undefined,
  ): Promise<{ headCursor: Cursor | null; backlogCount: number }> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      return await withTenant(tenant, orgId, (tx) =>
        tailMeta(tx, { endpointId, sinceCursor: resume }),
      );
    } finally {
      await tenant.end();
    }
  }

  /** Stop polling once no sockets remain so the DO can hibernate/evict between sessions. */
  private async stopIfIdle(closing: WebSocket): Promise<void> {
    if (this.ctx.getWebSockets().filter((s) => s !== closing).length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async persistCursor(cur: Cursor): Promise<void> {
    await this.ctx.storage.put<StoredCursor>("cursor", { orderKey: cur.orderKey, id: cur.id });
  }

  private toCursor(stored: StoredCursor | undefined): Cursor | undefined {
    // A pre-deploy record with the old {receivedAtMs} shape lacks `orderKey` → treated as unset, so the
    // session reseeds from `--since` (cold start). Acceptable: no gapless-critical durable cursors at baseline.
    return stored && typeof stored.orderKey === "string"
      ? { orderKey: stored.orderKey, id: stored.id }
      : undefined;
  }

  /** Send without letting a dead socket abort the broadcast or throw out of an event handler. */
  private safeSend(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch (err) {
      console.log(JSON.stringify({ message: "listen.send_failed", error: String(err) }));
    }
  }
}
