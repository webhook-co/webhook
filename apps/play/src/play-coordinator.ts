import { DurableObject } from "cloudflare:workers";

import type { Env } from "./index";

/**
 * A single global Durable Object (idFromName("global")) that gates minting — the circuit-breaker that
 * stops unauthenticated /play minting from being scaled into a cost/availability DoS. It tracks each
 * live token's IP and absolute expiry, and refuses a mint when the platform-wide active count or the
 * per-IP count is over budget. It self-prunes by expiry on every reserve, so it needs no release call
 * from the per-token sessions (every token has an absolute TTL, so an expired row is dead weight).
 */
export class PlayCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `create table if not exists active (token text primary key, ip text, expires_at integer);
       create index if not exists active_ip on active (ip);
       create index if not exists active_exp on active (expires_at);`,
    );
  }

  /** Reserve a slot for a new token. Returns whether the mint may proceed. */
  reserve(input: {
    token: string;
    ip: string;
    expiresAt: number;
    now: number;
    maxActive: number;
    maxPerIp: number;
  }): { ok: boolean; reason?: "global" | "ip" } {
    const sql = this.ctx.storage.sql;
    // Prune everything already past its absolute TTL — those slots are free.
    sql.exec("delete from active where expires_at <= ?", input.now);

    const total = Number(sql.exec("select count(*) as n from active").toArray()[0]?.n ?? 0);
    if (total >= input.maxActive) return { ok: false, reason: "global" };

    const perIp = Number(
      sql.exec("select count(*) as n from active where ip = ?", input.ip).toArray()[0]?.n ?? 0,
    );
    if (perIp >= input.maxPerIp) return { ok: false, reason: "ip" };

    sql.exec(
      "insert into active (token, ip, expires_at) values (?, ?, ?) on conflict(token) do nothing",
      input.token,
      input.ip,
      input.expiresAt,
    );
    return { ok: true };
  }
}
