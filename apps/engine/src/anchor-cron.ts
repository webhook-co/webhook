import { anchorR2Key, buildAnchor } from "@webhook-co/shared";

// The WORM head-anchor cron logic (ADR-0004). Pure + dependency-injected so it
// unit-tests with fakes; the engine's scheduled() handler wires the real deps (a webhook_anchor
// DB connection, the R2 anchor bucket, the audit HMAC key from a secret). For each org's chain
// head it writes one immutable anchor object, keyed by (org, seq), via a CREATE-ONLY put: an
// existing key is left untouched, so a head gets exactly one write-once anchor and a racing
// overlap can't overwrite it (the R2 retention lock is the second line of defence). The detection
// window equals the cron interval (ADR-0004).

/** A per-org chain head to anchor. Kept local so this pure module doesn't import the Node-typed db package. */
export interface AnchorHead {
  readonly orgId: string;
  readonly seq: number;
  readonly rowHash: Uint8Array;
}

export interface AnchorCronDeps {
  /** Read every org's current chain head (a webhook_anchor cross-org read). */
  readHeads: () => Promise<readonly AnchorHead[]>;
  /**
   * Write the anchor body at `key` ONLY if no object exists there yet (atomic create-only, e.g.
   * R2 put with `If-None-Match: *`). Returns true if written, false if an anchor already existed.
   */
  putAnchorIfAbsent: (key: string, body: string) => Promise<boolean>;
  /** Audit-chain HMAC key (from a Worker secret) used to MAC each anchor. */
  key: CryptoKey;
  /** Epoch ms stamped as `anchoredAt` (injected for determinism). */
  now: number;
  /** Optional structured logger. Only non-PII fields (org id, seq, counts) are passed. */
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export interface AnchorCronResult {
  readonly orgsSeen: number;
  readonly anchorsWritten: number;
  readonly skipped: number;
  /** Orgs whose anchor write failed; logged and counted, not fatal to the rest of the run. */
  readonly failed: number;
}

/** Write a write-once head-anchor for every org whose current head isn't anchored yet. */
export async function runAnchorCron(deps: AnchorCronDeps): Promise<AnchorCronResult> {
  const heads = await deps.readHeads();
  let anchorsWritten = 0;
  let skipped = 0;
  let failed = 0;

  for (const head of heads) {
    const objectKey = anchorR2Key(head.orgId, head.seq);
    try {
      // Build the anchor (a cheap HMAC) then create-only put: if the head is already anchored the
      // put is a no-op and reports false. One round-trip, no check-then-write race.
      const { serialized } = await buildAnchor(deps.key, head, deps.now);
      if (await deps.putAnchorIfAbsent(objectKey, serialized)) {
        anchorsWritten++;
      } else {
        skipped++;
      }
    } catch (err) {
      // One org's R2/network blip must not block anchoring the others; surface it and continue.
      failed++;
      deps.log?.("audit anchor failed for org", {
        orgId: head.orgId,
        seq: head.seq,
        error: String(err),
      });
    }
  }

  const result = { orgsSeen: heads.length, anchorsWritten, skipped, failed };
  deps.log?.("audit anchor cron complete", { ...result });
  return result;
}
