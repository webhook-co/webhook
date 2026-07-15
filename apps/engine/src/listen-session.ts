import { DurableObject } from "cloudflare:workers";

import {
  createClient,
  readMembershipRole,
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
  LISTEN_KEEPALIVE_PING,
  LISTEN_KEEPALIVE_PONG,
  msToOrderKey,
  orderKeyLagMs,
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
 * How often the poll re-checks that the bound user is still a member of the org (S.8). The socket is
 * authorized once at upgrade and then hibernates across evictions for days; without a re-check, a removed
 * member's open tab keeps streaming event metadata. ~30s bounds that leak without adding meaningful load:
 * one indexed membership read on a short-lived tenant client (the same per-operation client pattern the poll
 * already uses every ~2s), and only once per interval, not every poll.
 */
export const REAUTH_INTERVAL_MS = 30_000;

/**
 * Absolute lifetime of a live-events socket before it is force-closed and the client must re-mint (S.8).
 * A fresh mint re-runs the session + endpoint-ownership RLS check, so this bounds ANY stale authorization —
 * a revoked SESSION on a still-member user, a userless CLI socket — that the membership check alone can't
 * catch. The client reconnects seamlessly, resuming from its acked cursor.
 */
export const MAX_SESSION_LIFETIME_MS = 30 * 60_000;

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
/** The user id the ticket was minted for (dashboard path); absent on the CLI/bearer path. */
const HDR_USER = "x-listen-user-id";
const HDR_SINCE = "x-listen-since-cursor";
/** `?since=<grammar>` (now|beginning|<duration>|<RFC3339>): resolved server-side to a boundary cursor. */
const HDR_SINCE_SPEC = "x-listen-since-spec";
/** The WebSocket subprotocol to echo on the 101 (dashboard ticket path) — a browser aborts if unechoed. */
const HDR_ACCEPT_SUBPROTOCOL = "x-listen-accept-subprotocol";

/** The org/endpoint/session this DO is pinned to, persisted once on first connect. */
interface Binding {
  readonly orgId: string;
  readonly endpointId: string;
  readonly sessionId: string;
  /**
   * The user this socket was authorized for (dashboard ticket path). Carried so the poll can periodically
   * re-check they are still a member of `orgId` (S.8). Absent on the CLI/bearer path, where the api key is
   * the revocable credential and no membership check applies.
   */
  readonly userId?: string;
  /** Wall-clock ms when the binding was first established — the absolute-lifetime cap reads it (S.8). */
  readonly boundAtMs: number;
}

/** The durable resume position (last ACKed cursor). Stores the cursor's UTC ISO-µs `orderKey` verbatim (a
 *  plain string is JSON/structured-clone clean) so the resume keeps FULL microsecond precision — storing a
 *  ms epoch here would re-truncate the cursor and re-deliver same-ms events on resume. */
interface StoredCursor {
  readonly orderKey: string;
  readonly id: string;
}

/** The PRE-µs durable shape (ms epoch), still on disk for sessions that acked before this deploy. `toCursor`
 *  upgrades it in place rather than discarding it — see the comment there. */
interface LegacyStoredCursor {
  readonly receivedAtMs: number;
  readonly id: string;
}

type AnyStoredCursor = StoredCursor | LegacyStoredCursor;

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
  /**
   * In-memory only: wall-clock ms of the last membership re-check. Starts at 0 so the FIRST poll after any
   * (re)start — including a resume from hibernation — re-checks immediately, which is exactly when a socket
   * that survived an eviction should be re-authorized. Lost on eviction by design.
   */
  private lastReauthMs = 0;

  constructor(ctx: DurableObjectState, env: ListenEnv) {
    super(ctx, env);
    // Import the cursor HMAC key before any handler runs (re-runs on each hibernation wake).
    ctx.blockConcurrencyWhile(async () => {
      this.cursorKey = await importCursorKey(b64ToBytes(await readSecretBinding(env.CURSOR_KEY)));
    });
    // A `ping` DATA MESSAGE is auto-answered with `pong` without waking the DO — a hibernation-friendly
    // keepalive the CLI drives on an idle interval. Same shared constants the CLI sends (no drift).
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(LISTEN_KEEPALIVE_PING, LISTEN_KEEPALIVE_PONG),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const orgId = request.headers.get(HDR_ORG);
    const endpointId = request.headers.get(HDR_ENDPOINT);
    const sessionId = request.headers.get(HDR_SESSION);
    const userId = request.headers.get(HDR_USER) ?? undefined; // dashboard path only; CLI/bearer omit it
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
      // RESET the lifetime clock on this reconnect. Reaching here means the upgrade handler already verified
      // a FRESH credential (a newly-minted 60s ticket, or a live bearer) for this exact binding — i.e. the
      // client just re-authorized. The absolute-lifetime cap exists to FORCE that periodic re-auth, not to
      // kill a session that keeps proving itself: without this reset a client that reconnects with the same
      // sticky sessionId would land on the same DO with the old boundAtMs and be re-closed 1008 immediately,
      // permanently wedging the tail (and hot-looping the CLI). The membership subject may also have arrived
      // (an older userless ticket upgrading to a userful one), so refresh it too. Cursor/binding identity are
      // unchanged, so the resume stays seamless.
      await this.ctx.storage.put<Binding>("binding", {
        ...existing,
        ...(userId ? { userId } : {}),
        boundAtMs: Date.now(),
      });
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
      await this.ctx.storage.put<Binding>("binding", {
        orgId,
        endpointId,
        sessionId,
        ...(userId ? { userId } : {}),
        boundAtMs: Date.now(),
      });
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
        const resume = this.toCursor(await this.ctx.storage.get<AnyStoredCursor>("cursor"));
        const meta = await this.backlogMeta(orgId, endpointId, resume);
        const caughtUp = meta.backlogCount === 0;
        const headLagMs =
          meta.headCursor === null
            ? undefined
            : orderKeyLagMs(meta.headCursor.orderKey, Date.now());
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
    if (!(await this.runPoll())) await this.armPoll();
    // Echo the accepted subprotocol on the 101 when the upgrade handler asked for it (the dashboard ticket
    // path). workerd does NOT auto-negotiate `Sec-WebSocket-Protocol`, and a browser that offered a
    // subprotocol aborts the connection unless the server accepts exactly one — so this echo is load-bearing
    // for the browser client. The CLI offers no subprotocol, so the header is absent and nothing is echoed.
    const acceptSubprotocol = request.headers.get(HDR_ACCEPT_SUBPROTOCOL);
    const responseHeaders = acceptSubprotocol
      ? { "Sec-WebSocket-Protocol": acceptSubprotocol }
      : undefined;
    return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
  }

  override async alarm(): Promise<void> {
    // No listeners → stop the loop without re-arming; a future connect re-arms it.
    if (this.ctx.getWebSockets().length === 0) return;
    if (!(await this.runPoll())) await this.armPoll();
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
  private async runPoll(): Promise<boolean> {
    const sockets = this.ctx.getWebSockets();
    const binding = await this.ctx.storage.get<Binding>("binding");
    if (!binding || sockets.length === 0) return false;

    // Re-authorize BEFORE streaming any more events (S.8): the socket was authorized once at upgrade and
    // then hibernates across evictions for days. A revoked authorization must lose the tail, not keep it.
    // Returning true tells the caller NOT to re-arm the alarm (terminate already deleted it).
    const revoked = await this.reauthReason(binding);
    if (revoked) {
      await this.terminate(revoked);
      return true;
    }

    try {
      const resume =
        this.lastSent ?? this.toCursor(await this.ctx.storage.get<AnyStoredCursor>("cursor"));
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
    return false;
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

  /**
   * Decide whether this socket's authorization is still valid, returning a close reason or null. Two
   * independent bounds (S.8):
   *
   *  - ABSOLUTE LIFETIME (both paths): a socket older than MAX_SESSION_LIFETIME_MS is closed so the client
   *    must re-mint. A fresh mint re-runs the session + endpoint-ownership RLS check, bounding any stale
   *    authorization the membership check can't see (a revoked session on a still-member user, a userless
   *    CLI socket).
   *  - PERIODIC MEMBERSHIP (dashboard tickets, which carry a userId): every REAUTH_INTERVAL_MS, confirm the
   *    bound user is still a member of the org. A removed member loses the tail within one interval.
   *
   * Fails OPEN on a membership-read error — a transient tenant-DB blip must not kick every legitimate
   * viewer (the lifetime cap is the backstop), and we do NOT advance the timer, so it retries next poll.
   */
  private async reauthReason(binding: Binding): Promise<string | null> {
    // FAIL CLOSED on a missing/non-finite boundAtMs. A socket already open when this change deployed has a
    // binding persisted WITHOUT boundAtMs; `Date.now() - undefined` is NaN and `NaN > MAX` is false, so the
    // cap would never fire — and such legacy bindings also carry no userId, so the membership check is
    // skipped too. That is exactly the socket S.8 must bound (a hibernated tail that survives the deploy):
    // treat an absent clock as already-expired so it terminates and the client re-mints (establishing a real
    // boundAtMs). `!Number.isFinite` catches both undefined→NaN and any garbled value.
    const age = Date.now() - binding.boundAtMs;
    if (!Number.isFinite(age) || age > MAX_SESSION_LIFETIME_MS) {
      return "session lifetime reached — reconnect";
    }
    if (binding.userId !== undefined && Date.now() - this.lastReauthMs > REAUTH_INTERVAL_MS) {
      // Advance the throttle BEFORE the read, unconditionally. On a tenant-DB blip checkStillMember throws
      // and we fail open (keep the socket — the lifetime cap is the backstop), but we must NOT then retry on
      // every 2s poll: that would open a fresh tenant connection every 2s per socket exactly when the DB is
      // already struggling — a self-inflicted connection storm. Advancing here makes the next attempt wait
      // the full interval regardless of outcome; the lifetime cap still bounds a persistently-unverifiable
      // socket.
      this.lastReauthMs = Date.now();
      try {
        if (!(await this.checkStillMember(binding))) return "membership revoked";
      } catch (err) {
        console.log(JSON.stringify({ message: "listen.reauth_degraded", error: String(err) }));
      }
    }
    return null;
  }

  /**
   * Is the bound user still a member of the bound org? Reads `memberships` under the org's RLS on a
   * short-lived tenant client as webhook_app (which holds SELECT on memberships). Overridable seam in tests
   * (no live Postgres). Only called when `binding.userId` is set.
   */
  protected async checkStillMember(binding: Binding): Promise<boolean> {
    if (binding.userId === undefined) return true;
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      const role = await withTenant(tenant, binding.orgId, (tx) =>
        readMembershipRole(tx, binding.orgId, binding.userId as string),
      );
      return role !== null;
    } finally {
      await tenant.end();
    }
  }

  /**
   * Tear down every socket with a policy-violation close (1008) carrying a machine-readable REAUTHORIZE
   * frame first, then stop the poll loop. The client reconnects and re-mints; a still-authorized user
   * resumes seamlessly from its acked cursor, a revoked one's re-mint fails and it stops.
   */
  private async terminate(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      this.safeSend(ws, encodeServerFrame({ type: "error", code: "REAUTHORIZE", message: reason }));
      try {
        ws.close(1008, reason.slice(0, 120)); // WS close reason must be <= 123 bytes
      } catch {
        /* already closing/closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
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

  private toCursor(stored: AnyStoredCursor | undefined): Cursor | undefined {
    if (!stored) return undefined;
    // Current shape: the v2 order key, used verbatim.
    if ("orderKey" in stored && typeof stored.orderKey === "string") {
      return { orderKey: stored.orderKey, id: stored.id };
    }
    // Pre-deploy shape {receivedAtMs}: UPGRADE it in place to the equivalent ms-boundary order key. The old
    // cursor was already ms-precision, so `.sss000Z` resumes from the SAME position — no gap, at most a few
    // same-ms duplicates (at-least-once already tolerates those). This avoids resuming with an unset cursor,
    // which would be oldest-inclusive and re-flood the whole backlog as duplicate frames.
    if ("receivedAtMs" in stored && typeof stored.receivedAtMs === "number") {
      return { orderKey: msToOrderKey(stored.receivedAtMs), id: stored.id };
    }
    return undefined;
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
