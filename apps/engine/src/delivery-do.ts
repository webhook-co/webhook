// The per-destination outbound-delivery Durable Object (S3 Slice 3). One DO instance per replay destination
// (idFromName(destinationId)) is the FIFO + isolation + retry partition (internal-decisions-0002: DO-per-
// endpoint + alarm retries, OUTBOUND only). It is alarm-driven: a producer `wake()`s it after durably
// enqueuing a delivery (a `queued` delivery_attempts row, PR2); each alarm drains the destination's DUE
// deliveries through the SAME guarded pipeline DeliveryDispatcher uses (SSRF guard + Standard Webhooks
// signing), recording outcomes, scheduling retries on the fixed exponential schedule, and dead-lettering on
// exhaustion — then re-arms its single alarm for the soonest next-due.
//
// This file is the THIN SHELL: storage (the binding + alarm) + the I/O wiring of the drain's deps. The pure
// decision logic (FIFO order, the strict-ordered gate, retry/dead scheduling) lives in delivery-drain.ts and
// is unit-tested there. Neon (delivery_attempts) is the durable source of truth; the DO holds only its
// (orgId, destinationId) binding. The engine binds HYPERDRIVE_TENANT as webhook_app, so the DO writes the
// lifecycle directly under the org's RLS — no api callback. The alarm handler is FAIL-SAFE: it never throws
// (a thrown alarm stops the runtime's retry after ~6 tries and the queue would wedge).

import {
  createClient,
  getActiveSigningSecrets,
  isDestinationOrdered,
  listDueDeliveries,
  markDeliveryDelivered,
  markDeliveryTerminalFailure,
  nextDueAt,
  scheduleDeliveryRetry,
  withTenant,
  type DueDelivery,
} from "@webhook-co/db";
import type { DeliverResult, SealedSigningSecret } from "@webhook-co/shared";
import { DurableObject } from "cloudflare:workers";

import { guardedDeliver, makeSignDelivery, resolveViaDoh } from "./delivery-dispatcher";
import { runDeliveryDrain } from "./delivery-drain";
// getSignStore lives in index.ts; the index re-exports this class, so this is a runtime-safe ESM cycle —
// getSignStore is referenced ONLY inside the drain (long after both modules finish evaluating), never at
// module-eval time, so the live binding is always populated by the time it's read.
import { getSignStore, type Env } from "./index";

/** The DO's only persistent state: which (org, destination) it serves. Set on first wake. */
interface DeliveryBinding {
  readonly orgId: string;
  readonly destinationId: string;
}

/** Max deliveries a single alarm drains (bounded; the re-arm loops if more remain due). */
const MAX_PER_DRAIN = 50;
/** Fallback re-arm when the drain itself faults, so a transient error retries soon (never goes dark). */
const REARM_FALLBACK_MS = 30_000;

export class DeliveryDO extends DurableObject<Env> {
  // Bumped on every wake(). The alarm's re-arm reads it to detect a wake() that landed DURING the drain:
  // the DO input gate is open across the drain's network I/O, so a producer can enqueue + wake mid-alarm.
  // Our nextDue read can't have seen that brand-new delivery, so trusting it (and possibly deleteAlarm-ing)
  // would strand the delivery with no pending alarm — instead a raced wake forces a prompt re-fire.
  #wakeSeq = 0;

  /**
   * Wake this destination's DO: pin its (org, destination) binding on first call (idempotent), then ensure
   * the alarm fires promptly. A new delivery is due NOW, so arm if no alarm is set AND pull an existing
   * far-future alarm earlier (otherwise the new delivery would wait out an unrelated backoff window already
   * scheduled hours ahead). An alarm already at/behind now is left as-is (it is about to fire).
   */
  async wake(orgId: string, destinationId: string): Promise<void> {
    if ((await this.ctx.storage.get<DeliveryBinding>("binding")) === undefined) {
      await this.ctx.storage.put<DeliveryBinding>("binding", { orgId, destinationId });
    }
    this.#wakeSeq++;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > Date.now()) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /** FAIL-SAFE: never throws. Drains due deliveries, then re-arms its single alarm for the soonest next-due. */
  override async alarm(): Promise<void> {
    const binding = await this.ctx.storage.get<DeliveryBinding>("binding");
    if (binding === undefined) return; // nothing bound → idle; a future wake() re-arms
    const { orgId, destinationId } = binding;
    const seqAtEntry = this.#wakeSeq;
    let nextDue: Date | null = null;
    let drainThrew = false;
    try {
      nextDue = await this.drainOnce(orgId, destinationId);
    } catch (err) {
      // A drain failure must NOT escape (a thrown alarm wedges the queue) — log + re-arm so it retries.
      drainThrew = true;
      console.log(
        JSON.stringify({ message: "delivery.drain_degraded", destinationId, error: String(err) }),
      );
    }
    // Re-arm:
    //  - a wake() that raced the drain may have enqueued a now-due delivery our nextDue read missed — fire
    //    promptly and never deleteAlarm (which would strand it);
    //  - a drain throw re-arms near-term: a re-read right after the drain (which itself does DB I/O) just
    //    failed is unreliable, so a bounded retry is the robust choice (deliberate post-error backoff);
    //  - otherwise honor nextDue: a time (the soonest/head due) or null. null means nothing is ACTIONABLE —
    //    either genuinely no open deliveries, OR the destination is disabled/deleted so its still-open
    //    deliveries are paused (not deliverable now). Going idle is correct: the deliveries stay durably
    //    owed in Neon; resuming them on re-enable and cancelling them on delete is the lifecycle slice's job
    //    (PR3), which wakes this DO again. Idling here is what AVOIDS the busy-loop a stale now()-re-arm caused.
    if (this.#wakeSeq !== seqAtEntry) {
      await this.ctx.storage.setAlarm(Date.now());
    } else if (drainThrew) {
      await this.ctx.storage.setAlarm(Date.now() + REARM_FALLBACK_MS);
    } else if (nextDue !== null) {
      await this.ctx.storage.setAlarm(nextDue.getTime()); // a past time fires ASAP (more work now)
    } else {
      await this.ctx.storage.deleteAlarm(); // nothing actionable — idle until a future wake()
    }
  }

  /**
   * Drain the destination's due deliveries and return when the DO should next wake (null ⇒ nothing open).
   * Prefetches the due list + signing secrets + ordering mode in ONE read tx; the guarded POST happens with
   * NO DB tx held, each outcome write is its own short tx, and the next-due read runs on the SAME client
   * after the writes (no second connection). `protected` so the workerd shell test injects a fake.
   */
  protected async drainOnce(orgId: string, destinationId: string): Promise<Date | null> {
    const tenant = createClient(this.env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
    try {
      const { due, secrets, ordered } = await withTenant(tenant, orgId, async (tx) => ({
        due: await listDueDeliveries(tx, destinationId, MAX_PER_DRAIN),
        secrets: await getActiveSigningSecrets(tx, destinationId),
        ordered: await isDestinationOrdered(tx, destinationId),
      }));
      await runDeliveryDrain({
        listDue: async () => due,
        signingSecrets: async () => secrets,
        ordered: async () => ordered,
        deliver: (d, secs) => this.deliverOne(orgId, d, secs),
        recordDelivered: (d, statusCode) =>
          withTenant(tenant, orgId, (tx) =>
            markDeliveryDelivered(tx, { id: d.id, destinationId, attempt: d.attempt, statusCode }),
          ),
        recordRetry: (d, nextRetryAt, statusCode, error) =>
          withTenant(tenant, orgId, (tx) =>
            scheduleDeliveryRetry(tx, {
              id: d.id,
              nextAttempt: d.attempt + 1,
              nextRetryAt,
              statusCode,
              error,
            }),
          ),
        recordDead: (d, statusCode, error) =>
          withTenant(tenant, orgId, (tx) =>
            markDeliveryTerminalFailure(tx, {
              id: d.id,
              destinationId,
              status: "dead",
              attempt: d.attempt,
              statusCode,
              error,
            }),
          ),
        recordBlocked: (d, statusCode, error) =>
          withTenant(tenant, orgId, (tx) =>
            markDeliveryTerminalFailure(tx, {
              id: d.id,
              destinationId,
              status: "blocked",
              attempt: d.attempt,
              statusCode,
              error,
            }),
          ),
        now: () => Date.now(),
      });
      // Re-arm target, read AFTER the drain's writes so it reflects the new pending/terminal states.
      return await withTenant(tenant, orgId, (tx) => nextDueAt(tx, destinationId));
    } finally {
      await tenant.end().catch(() => undefined);
    }
  }

  /** ONE guarded, signed delivery attempt: the SSRF-guarded POST of the event's bytes, re-signed with the
   *  destination's secrets. webhook-id = the delivery row id (STABLE across retries → the receiver dedups a
   *  re-sent delivery); the timestamp is fresh per attempt (within the receiver's replay window). */
  private deliverOne(
    orgId: string,
    d: DueDelivery,
    secrets: readonly SealedSigningSecret[],
  ): Promise<DeliverResult> {
    return guardedDeliver(
      {
        getPayload: async (key) => {
          const obj = await this.env.R2_PAYLOADS.get(key);
          return obj === null ? null : await obj.arrayBuffer();
        },
        resolve: (host) => resolveViaDoh((input, init) => fetch(input, init), host),
        fetch: (input, init) => fetch(input, init),
        // Sign only when the destination has secrets; the store is built lazily (an unsigned destination
        // never touches KMS).
        sign:
          secrets.length > 0
            ? async (signArgs) => makeSignDelivery(await getSignStore(this.env))(signArgs)
            : undefined,
        now: () => Date.now(),
      },
      {
        orgId,
        endpointId: d.endpointId,
        dedupKey: d.dedupKey,
        url: d.url,
        headers: d.headers,
        signing:
          secrets.length > 0
            ? { webhookId: d.id, timestamp: Math.floor(Date.now() / 1000), secrets }
            : undefined,
      },
    );
  }
}
