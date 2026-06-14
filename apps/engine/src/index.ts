import { createClient, readAuditChainHeads } from "@webhook-co/db";
import { importAuditKey, SERVICE_NAME } from "@webhook-co/shared";

import { runAnchorCron } from "./anchor-cron";

// Placeholder webhook engine Worker. Real ingest/verify/deliver logic (Workers + Durable
// Objects) lands here. Handlers stay thin: validate -> delegate -> respond, and ACK fast.
// The scheduled() handler runs the WORM head-anchor cron (WS-C2, ADR-0004).

export interface Env {
  /** Hyperdrive config for the webhook_anchor cross-org head read (query caching off). */
  HYPERDRIVE_ANCHOR: Hyperdrive;
  /** R2 bucket holding the WORM head anchors (retention-locked; this writer has no delete rights). */
  R2_AUDIT_ANCHOR: R2Bucket;
  /** Base64 audit-chain HMAC key (Worker secret) — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: string;
}

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(`${SERVICE_NAME}:engine ok`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
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
  // Decode + validate the HMAC key BEFORE opening a connection. The secret is standard base64
  // (shared's base64 helpers are package-internal; atob is a Workers global). A too-short key
  // would otherwise silently MAC every anchor under a weak key and lock the bad anchors in for the
  // whole retention term.
  const raw = Uint8Array.from(atob(env.AUDIT_CHAIN_HMAC_KEY), (c) => c.charCodeAt(0));
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
