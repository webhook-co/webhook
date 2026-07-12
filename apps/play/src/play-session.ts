import { DurableObject } from "cloudflare:workers";

import {
  buildCaptureRecord,
  isExpired,
  MAX_REQUESTS_PER_TOKEN,
  sseComment,
  sseFrame,
  timingSafeEqual,
  type CaptureRecord,
} from "./core";
import type { Env } from "./index";

/**
 * One Durable Object per /play ingest token. It holds captures ONLY in its own ephemeral SQLite,
 * fans them out over SSE to the session-bound viewer, and hard-deletes everything on an ABSOLUTE-TTL
 * alarm set once at init and never re-armed — so a token cannot be held open indefinitely and the
 * "auto-deletes in minutes" promise is literally true. The class binds nothing (no DB/R2/KMS/Stripe)
 * and makes no outbound request: a compromise here reaches only this one ephemeral object.
 */
export class PlaySession extends DurableObject<Env> {
  /** Live SSE writers (the connected viewer, possibly reconnecting). In-memory; the connection keeps the DO warm. */
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `create table if not exists meta (
         k text primary key, minted_at integer, viewer_secret text, count integer, expires_at integer
       );
       create table if not exists captures (
         seq integer primary key autoincrement, id text, method text, headers text,
         content_type text, body text, body_bytes integer, truncated integer, received_at integer
       );`,
    );
  }

  /** Called once by the worker at mint. Records the session and arms the ABSOLUTE self-destruct alarm. */
  async init(input: {
    viewerSecret: string;
    mintedAt: number;
    ttlMs: number;
  }): Promise<{ expiresAt: number }> {
    const expiresAt = input.mintedAt + input.ttlMs;
    this.ctx.storage.sql.exec(
      `insert into meta (k, minted_at, viewer_secret, count, expires_at)
       values ('m', ?, ?, 0, ?)
       on conflict(k) do nothing`,
      input.mintedAt,
      input.viewerSecret,
      expiresAt,
    );
    // Absolute deadline — set ONCE, never refreshed by activity. This is the control that makes the
    // ephemerality promise true and stops /play being a durable dead-drop.
    await this.ctx.storage.setAlarm(expiresAt);
    return { expiresAt };
  }

  private meta(): {
    mintedAt: number;
    viewerSecret: string;
    count: number;
    expiresAt: number;
  } | null {
    const row = this.ctx.storage.sql
      .exec("select minted_at, viewer_secret, count, expires_at from meta where k='m'")
      .toArray()[0];
    if (!row) return null;
    return {
      mintedAt: Number(row.minted_at),
      viewerSecret: String(row.viewer_secret),
      count: Number(row.count),
      expiresAt: Number(row.expires_at),
    };
  }

  /** Capture one request. Enforces the absolute TTL and the per-token request cap, then fans out. */
  async capture(input: {
    method: string;
    headers: ReadonlyArray<readonly [string, string]>;
    bodyBytes: Uint8Array;
    now: number;
  }): Promise<{ accepted: boolean; reason?: "expired" | "cap" | "uninitialized"; count: number }> {
    const m = this.meta();
    if (!m) return { accepted: false, reason: "uninitialized", count: 0 };
    if (isExpired(m.mintedAt, input.now, m.expiresAt - m.mintedAt)) {
      return { accepted: false, reason: "expired", count: m.count };
    }
    if (m.count >= MAX_REQUESTS_PER_TOKEN)
      return { accepted: false, reason: "cap", count: m.count };

    const record = buildCaptureRecord({
      id: crypto.randomUUID(),
      method: input.method,
      headers: input.headers,
      bodyBytes: input.bodyBytes,
      receivedAt: input.now,
    });
    this.ctx.storage.sql.exec(
      `insert into captures (id, method, headers, content_type, body, body_bytes, truncated, received_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.method,
      JSON.stringify(record.headers),
      record.contentType,
      record.body,
      record.bodyBytes,
      record.truncated ? 1 : 0,
      record.receivedAt,
    );
    const count = m.count + 1;
    this.ctx.storage.sql.exec("update meta set count=? where k='m'", count);
    // Fire-and-forget: the capture is already durable in SQLite, so we must NOT block the ingesting
    // request (the caller's curl) on a slow or stalled viewer's backpressure. A viewer that falls
    // behind recovers via replay on reconnect.
    void this.fanOut(record);
    return { accepted: true, count };
  }

  private async fanOut(record: CaptureRecord): Promise<void> {
    const frame = new TextEncoder().encode(sseFrame(record));
    // Concurrent, not sequential — one stalled writer must not delay the others.
    await Promise.allSettled(
      [...this.writers].map(async (w) => {
        try {
          await w.write(frame);
        } catch {
          this.writers.delete(w);
        }
      }),
    );
  }

  private replay(): CaptureRecord[] {
    return this.ctx.storage.sql
      .exec("select * from captures order by seq asc")
      .toArray()
      .map((r) => ({
        id: String(r.id),
        method: String(r.method),
        headers: JSON.parse(String(r.headers)) as Array<[string, string]>,
        contentType: r.content_type === null ? null : String(r.content_type),
        body: String(r.body),
        bodyBytes: Number(r.body_bytes),
        truncated: Number(r.truncated) === 1,
        receivedAt: Number(r.received_at),
      }));
  }

  /**
   * The SSE stream. SESSION-BOUND: the caller must present the viewer secret handed to the minting
   * browser — a bare token URL cannot read the stream, so an attacker can't broadcast a captured
   * payload to a third party via a shared link. Replays what's captured so far, then streams new
   * captures until the token expires.
   */
  override async fetch(request: Request): Promise<Response> {
    // The viewer secret arrives via an internal header the worker sets from the HttpOnly cookie — NOT
    // from the URL, so it never lands in a request-URL log (defeating log-based session hijack).
    const presented = request.headers.get("x-play-viewer") ?? "";
    const m = this.meta();
    if (!m || !timingSafeEqual(presented, m.viewerSecret)) {
      // Same response whether the token is unknown or the secret is wrong — no oracle.
      return new Response("forbidden", { status: 403 });
    }

    // Snapshot the replay BEFORE joining the fan-out set (both are synchronous, no await between, so
    // no capture can interleave): a capture then lands EITHER in the snapshot (writer not yet live)
    // OR via fan-out (after we join) — never both, so the viewer never sees a duplicate.
    const snapshot = this.replay();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.writers.add(writer);
    const enc = new TextEncoder();

    // Replay history + a keepalive, but WITHOUT blocking the Response return: awaiting these writes
    // before returning would deadlock — with no reader yet, the writer hits backpressure while the
    // reader is waiting for this very Response. Run the replay in a detached loop; the reader drains
    // it as it connects.
    void (async () => {
      try {
        for (const rec of snapshot) await writer.write(enc.encode(sseFrame(rec)));
        await writer.write(enc.encode(sseComment(`expires ${m.expiresAt}`)));
      } catch {
        this.writers.delete(writer);
      }
    })();

    request.signal.addEventListener("abort", () => {
      this.writers.delete(writer);
      writer.close().catch(() => {});
    });

    return new Response(stream.readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    });
  }

  /** Absolute-TTL self-destruct: hard-delete every capture and the session, and close all streams. */
  override async alarm(): Promise<void> {
    for (const w of [...this.writers]) {
      this.writers.delete(w);
      try {
        await w.close();
      } catch {
        /* already gone */
      }
    }
    // Hard-delete the captured DATA (the sensitive part) but keep the empty schema so a late request
    // to this now-defunct token resolves cleanly to "uninitialized" (404) rather than throwing on a
    // dropped table. `deleteAll()` would drop the SQLite schema out from under the live DO instance.
    this.ctx.storage.sql.exec("delete from captures; delete from meta;");
  }
}
