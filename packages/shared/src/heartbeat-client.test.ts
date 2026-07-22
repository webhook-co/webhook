import { describe, expect, it, vi } from "vitest";

import { reportHeartbeat, withHeartbeat, type HeartbeatEnv } from "./heartbeat-client.js";

const env: HeartbeatEnv = {
  HEALTH_HEARTBEAT_URL: "https://health.wbhk.my",
  HEARTBEAT_TOKEN: "s3cret",
};

const okFetch = () => vi.fn(async () => new Response("recorded", { status: 202 }));

describe("reportHeartbeat", () => {
  it("posts to the job's endpoint with the bearer credential", async () => {
    const f = okFetch();
    await reportHeartbeat(env, "anchor", true, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://health.wbhk.my/internal/heartbeat/anchor?status=ok");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
  });

  it("distinguishes a failed run from a successful one", async () => {
    const f = okFetch();
    await reportHeartbeat(env, "anchor", false, f as unknown as typeof fetch);
    expect(f.mock.calls[0]?.[0]).toContain("status=fail");
  });

  it("tolerates a trailing slash on the base url", async () => {
    const f = okFetch();
    await reportHeartbeat(
      { ...env, HEALTH_HEARTBEAT_URL: "https://health.wbhk.my///" },
      "anchor",
      true,
      f as unknown as typeof fetch,
    );
    expect(f.mock.calls[0]?.[0]).toBe("https://health.wbhk.my/internal/heartbeat/anchor?status=ok");
  });

  it("escapes the job id rather than interpolating it raw into the path", async () => {
    const f = okFetch();
    await reportHeartbeat(env, "a/../b", true, f as unknown as typeof fetch);
    expect(f.mock.calls[0]?.[0]).toContain("a%2F..%2Fb");
  });

  // Ships dark: the callers can land and deploy before apps/health exists.
  it.each([
    ["no url", { HEARTBEAT_TOKEN: "s3cret" }],
    ["no token", { HEALTH_HEARTBEAT_URL: "https://health.wbhk.my" }],
    ["neither", {}],
    ["an empty token", { HEALTH_HEARTBEAT_URL: "https://health.wbhk.my", HEARTBEAT_TOKEN: "" }],
  ])("is a no-op with %s", async (_label, partial) => {
    const f = okFetch();
    await reportHeartbeat(partial as HeartbeatEnv, "anchor", true, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });

  // Rule 1. A cron that dies because its telemetry failed is far worse than a false alarm.
  it("never rejects, whatever the transport does", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    await expect(
      reportHeartbeat(env, "anchor", true, throwing as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("never rejects on a non-2xx response", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      reportHeartbeat(env, "anchor", true, failing as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
  // REGRESSION (CodeQL js/polynomial-redos). The trailing-slash trim used to be a regex, which
  // backtracks polynomially on a long run of slashes. The URL constructor is linear and also
  // resolves the path correctly, so this must stay fast AND produce the right target.
  it("normalises a pathological run of slashes quickly and correctly", async () => {
    const f = okFetch();
    const started = Date.now();
    await reportHeartbeat(
      { ...env, HEALTH_HEARTBEAT_URL: `https://health.wbhk.my${"/".repeat(50_000)}` },
      "anchor",
      true,
      f as unknown as typeof fetch,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.mock.calls[0]?.[0]).toBe("https://health.wbhk.my/internal/heartbeat/anchor?status=ok");
  });

  it("disables reporting when the configured base url is malformed", async () => {
    const f = okFetch();
    await reportHeartbeat(
      { ...env, HEALTH_HEARTBEAT_URL: "not a url" },
      "anchor",
      true,
      f as unknown as typeof fetch,
    );
    expect(f).not.toHaveBeenCalled();
  });
});

describe("withHeartbeat", () => {
  it("runs the job and reports success", async () => {
    const f = okFetch();
    let ran = 0;
    await withHeartbeat(env, "anchor", async () => void ran++, {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(ran).toBe(1);
    expect(f.mock.calls[0]?.[0]).toContain("status=ok");
  });

  // The distinction that makes the signal useful: a job that RAN AND FAILED is not the same fact as
  // one that never ran at all, and only the former can be reported.
  it("reports a failure instead of swallowing it silently", async () => {
    const f = okFetch();
    await withHeartbeat(
      env,
      "anchor",
      async () => {
        throw new Error("db down");
      },
      { fetchImpl: f as unknown as typeof fetch },
    );
    expect(f.mock.calls[0]?.[0]).toContain("status=fail");
  });

  it("never lets a failing job escape as a rejection", async () => {
    const f = okFetch();
    await expect(
      withHeartbeat(
        env,
        "anchor",
        async () => {
          throw new Error("boom");
        },
        { fetchImpl: f as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
  });

  it("still runs the job when reporting is switched off", async () => {
    const f = okFetch();
    let ran = 0;
    await withHeartbeat({}, "anchor", async () => void ran++, {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(ran).toBe(1);
    expect(f).not.toHaveBeenCalled();
  });

  // A hung health Worker must not hold a cron's invocation open.
  it("bounds the report with a timeout signal", async () => {
    const f = okFetch();
    await withHeartbeat(env, "anchor", async () => {}, { fetchImpl: f as unknown as typeof fetch });
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
  // REGRESSION. runNotificationDrain and runAuthExpirySweep CATCH their own errors and signal
  // failure by returning null — they are documented never to reject. Treating only a throw as
  // failure reported those jobs healthy while broken, which is the exact false-healthy signal this
  // mechanism exists to prevent.
  it("reports failure when a job signals it by returning null instead of throwing", async () => {
    const f = okFetch();
    await withHeartbeat(env, "notification-drain", async () => null, {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(f.mock.calls[0]?.[0]).toContain("status=fail");
  });

  it("still treats a void or valued return as success", async () => {
    for (const value of [undefined, 0, "", { refreshTokens: 0 }]) {
      const f = okFetch();
      await withHeartbeat(env, "auth-expiry-sweep", async () => value, {
        fetchImpl: f as unknown as typeof fetch,
      });
      expect(f.mock.calls[0]?.[0], String(value)).toContain("status=ok");
    }
  });

  it("honours a caller-supplied success predicate", async () => {
    const f = okFetch();
    await withHeartbeat(env, "anchor", async () => ({ anchored: 0 }), {
      succeeded: (r) => (r as { anchored: number }).anchored > 0,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(f.mock.calls[0]?.[0]).toContain("status=fail");
  });

  // The credential must not be replayed to a host the operator did not configure.
  it("refuses a non-https base url and never follows a redirect", async () => {
    const f = okFetch();
    await withHeartbeat(
      { ...env, HEALTH_HEARTBEAT_URL: "http://health.wbhk.my" },
      "anchor",
      async () => {},
      { fetchImpl: f as unknown as typeof fetch },
    );
    expect(f).not.toHaveBeenCalled();

    const g = okFetch();
    await withHeartbeat(env, "anchor", async () => {}, { fetchImpl: g as unknown as typeof fetch });
    expect((g.mock.calls[0]?.[1] as RequestInit).redirect).toBe("error");
  });
  // REGRESSION. A cron's throw can carry a Hyperdrive connection string, which embeds a role
  // credential. Logging String(err) here would put it in Workers logs — and this helper is the
  // shape every future cron call site copies.
  it("logs a throw's NAME, never its message", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const f = okFetch();
    const boom = new Error("postgres://webhook_app:sup3rs3cret@ep-x.neon.tech/db");
    boom.name = "ConnectionError";
    await withHeartbeat(
      env,
      "audit-anchor",
      async () => {
        throw boom;
      },
      { fetchImpl: f as unknown as typeof fetch },
    );
    spy.mockRestore();

    const joined = lines.join("\n");
    expect(joined).toContain("ConnectionError");
    expect(joined).not.toContain("sup3rs3cret");
    expect(joined).not.toContain("postgres://");
    expect(f.mock.calls[0]?.[0]).toContain("status=fail"); // still reported as a failure
  });
});
