import { DurableObject } from "cloudflare:workers";

import { createClient, tailEvents, withTenant, type Page } from "@webhook-co/db";
import {
  b64ToBytes,
  decodeCursor,
  encodeCursor,
  importCursorKey,
  readSecretBinding,
  WATERMARK_DELTA_MS,
  type Cursor,
  type EventSummary,
} from "@webhook-co/shared";

import { encodeServerFrame, parseClientFrame } from "./listen-protocol";

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
export async function drainPages(
  readPage: (resume: Cursor | undefined) => Promise<Page<EventSummary>>,
  resume: Cursor | undefined,
  maxPages: number = MAX_PAGES_PER_POLL,
): Promise<EventSummary[]> {
  const drained: EventSummary[] = [];
  let cursor = resume;
  for (let page = 0; page < maxPages; page++) {
    const result = await readPage(cursor);
    drained.push(...result.items);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return drained;
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

/** The org/endpoint/session this DO is pinned to, persisted once on first connect. */
interface Binding {
  readonly orgId: string;
  readonly endpointId: string;
  readonly sessionId: string;
}

/** The durable resume position (last ACKed cursor). Epoch-ms keeps it JSON/structured-clone clean. */
interface StoredCursor {
  readonly receivedAtMs: number;
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
      await this.ctx.storage.put<Binding>("binding", { orgId, endpointId, sessionId });
      // Seed the resume cursor from an initial ?sinceCursor= (a fresh `--since <cursor>` session).
      // It's HMAC-signed; a tampered/garbled one fails to decode → start from the oldest instead.
      const since = request.headers.get(HDR_SINCE);
      if (since) {
        try {
          await this.persistCursor(await decodeCursor(since, this.cursorKey));
        } catch {
          /* ignore an invalid initial cursor */
        }
      }
    }

    // Reset the in-session stream position so the first alarm after THIS connect resumes from the
    // durable acked cursor — re-delivering anything un-acked (at-least-once across reconnects, even
    // when the DO is still resident).
    this.lastSent = undefined;

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API (NOT server.accept()): the socket survives DO eviction. Tagged with the
    // sessionId so getWebSockets(tag) can address it; the binding lives in storage, not an attachment.
    this.ctx.acceptWebSocket(server, [sessionId]);
    server.send(
      encodeServerFrame({ type: "ready", sessionId, watermarkDeltaMs: WATERMARK_DELTA_MS }),
    );

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
      const events = await this.pollEvents(binding, resume);
      for (const summary of events) {
        const cur: Cursor = { receivedAt: summary.receivedAt, id: summary.id };
        const frame = encodeServerFrame({
          type: "event",
          summary,
          cursor: await encodeCursor(cur, this.cursorKey),
        });
        for (const ws of sockets) this.safeSend(ws, frame);
        this.lastSent = cur;
      }
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
   * (inject a canned reader; no live Postgres). Returns the drained batch the poll will broadcast.
   */
  protected async pollEvents(
    binding: Binding,
    resume: Cursor | undefined,
  ): Promise<EventSummary[]> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      return await drainPages(
        (cursor) =>
          withTenant(tenant, binding.orgId, (tx) =>
            tailEvents(tx, { endpointId: binding.endpointId, sinceCursor: cursor }),
          ),
        resume,
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
    await this.ctx.storage.put<StoredCursor>("cursor", {
      receivedAtMs: cur.receivedAt.getTime(),
      id: cur.id,
    });
  }

  private toCursor(stored: StoredCursor | undefined): Cursor | undefined {
    return stored ? { receivedAt: new Date(stored.receivedAtMs), id: stored.id } : undefined;
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
