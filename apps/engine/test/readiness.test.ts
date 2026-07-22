import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import {
  ingestReadinessChecks,
  READINESS_PROBE_KEY,
  type ReadinessEnv,
  type ReadinessProbes,
} from "../src/readiness";

/**
 * The readiness probes are injected, so this suite exercises the ingest path's real dependency
 * SELECTION and failure semantics without a live Postgres or R2. The live probe bodies are thin
 * wrappers over `select 1` / `head()`; what actually matters — and what a wrong edit would break —
 * is WHICH binding is probed and how a failure is reported.
 */

const healthyProbes = (): ReadinessProbes => ({
  pingDatabase: async () => {},
  headPayload: async () => {},
});

const envStub = (): ReadinessEnv => ({
  HYPERDRIVE_INGEST: { connectionString: "postgres://ingest-role" },
  R2_PAYLOADS: { head: async () => null },
});

const statusesOf = async (checks: Awaited<ReturnType<typeof ingestReadinessChecks>>) =>
  Object.fromEntries((await runChecks(checks, { timeoutMs: 500 })).map((o) => [o.name, o.status]));

describe("ingest readiness checks", () => {
  it("declares exactly the two dependencies on the ingest write path", () => {
    expect(Object.keys(ingestReadinessChecks(envStub(), healthyProbes())).sort()).toEqual([
      "database",
      "payloads",
    ]);
  });

  it("passes when both dependencies answer", async () => {
    expect(await statusesOf(ingestReadinessChecks(envStub(), healthyProbes()))).toEqual({
      database: "pass",
      payloads: "pass",
    });
  });

  // The ingest INSERT runs as webhook_ingest. Probing a different role's binding would report a
  // healthy database while the role that actually writes events is unreachable.
  it("probes the webhook_ingest binding, not another role's connection string", async () => {
    const seen: string[] = [];
    const checks = ingestReadinessChecks(envStub(), {
      ...healthyProbes(),
      pingDatabase: async (cs) => {
        seen.push(cs);
      },
    });
    await runChecks(checks, { timeoutMs: 500 });
    expect(seen).toEqual(["postgres://ingest-role"]);
  });

  it("reports fail — not a throw — when the database is unreachable", async () => {
    const checks = ingestReadinessChecks(envStub(), {
      ...healthyProbes(),
      pingDatabase: async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:5432");
      },
    });
    expect(await statusesOf(checks)).toEqual({ database: "fail", payloads: "pass" });
  });

  it("reports fail when the payload bucket is unreachable", async () => {
    const checks = ingestReadinessChecks(envStub(), {
      ...healthyProbes(),
      headPayload: async () => {
        throw new Error("R2 unavailable");
      },
    });
    expect(await statusesOf(checks)).toEqual({ database: "pass", payloads: "fail" });
  });

  // A head() on a key that was never written returns null, and that is a SUCCESS: it completed a
  // full authenticated round-trip to R2. Treating null as a failure would make readiness depend on
  // an object existing, which is a different (and wrong) question.
  it("treats an absent probe object as reachable, not as a failure", async () => {
    const seen: string[] = [];
    const checks = ingestReadinessChecks(
      { ...envStub(), R2_PAYLOADS: { head: async () => null } },
      {
        ...healthyProbes(),
        headPayload: async (bucket, key) => {
          seen.push(key);
          await bucket.head(key);
        },
      },
    );
    expect(await statusesOf(checks)).toEqual({ database: "pass", payloads: "pass" });
    expect(seen).toEqual([READINESS_PROBE_KEY]);
  });

  it("probes a key under a reserved name that ingest never writes", () => {
    // Ingest keys are derived from org/endpoint/event ids; a double-underscore sentinel cannot
    // collide with one, so the probe can never read a customer's payload.
    expect(READINESS_PROBE_KEY.startsWith("__")).toBe(true);
  });
});
