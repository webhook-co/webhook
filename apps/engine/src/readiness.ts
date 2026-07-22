import { pingDatabase } from "@webhook-co/db/health";
import type { Check } from "@webhook-co/shared/health";

/**
 * Readiness for the wbhk.my ingest apex.
 *
 * This is the counterpart to `/healthz`, not a replacement for it. `/healthz` answers "is this
 * Worker running" and deliberately touches nothing; `/readyz` answers "can this actually capture an
 * event", which means proving the two dependencies the ingest write path cannot proceed without:
 *
 *   1. **the payload bucket** — ingest is PUT-first (ADR-0013), so R2 is on the critical path
 *      BEFORE the row is written;
 *   2. **the webhook_ingest database role** — the binding that performs the `ingest_event` insert.
 *
 * Before this existed, `/healthz` returned a hardcoded `"ok"` and would have reported green
 * throughout a total database outage.
 *
 * The probes are injected so tests can exercise dependency selection and failure semantics without
 * a live Postgres or R2 — the live implementations below are deliberately thin.
 */

/**
 * The R2 key the readiness probe reads. Never written by anything.
 *
 * `head()` on an absent key is still a complete authenticated round-trip to R2, so reachability is
 * proven without requiring any object to exist. The double-underscore sentinel cannot collide with
 * a real payload key (those are derived from org/endpoint/event ids), so this probe can never read
 * a customer's payload.
 */
export const READINESS_PROBE_KEY = "__readiness_probe__";

/** The subset of the Worker Env that readiness needs — the full `Env` satisfies it structurally. */
export interface ReadinessEnv {
  readonly HYPERDRIVE_INGEST: { readonly connectionString: string };
  readonly R2_PAYLOADS: Pick<R2Bucket, "head">;
}

export interface ReadinessProbes {
  readonly pingDatabase: (connectionString: string) => Promise<void>;
  readonly headPayload: (bucket: Pick<R2Bucket, "head">, key: string) => Promise<void>;
}

export const liveProbes: ReadinessProbes = {
  pingDatabase,
  headPayload: async (bucket, key) => {
    await bucket.head(key);
  },
};

/** The named dependency checks for the ingest write path. */
export function ingestReadinessChecks(
  env: ReadinessEnv,
  probes: ReadinessProbes = liveProbes,
): Record<string, Check> {
  return {
    database: async () => {
      await probes.pingDatabase(env.HYPERDRIVE_INGEST.connectionString);
    },
    payloads: async () => {
      await probes.headPayload(env.R2_PAYLOADS, READINESS_PROBE_KEY);
    },
  };
}
