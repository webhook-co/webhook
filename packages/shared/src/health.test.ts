import { describe, expect, it, vi } from "vitest";

import {
  authedHealth,
  healthDocument,
  memoized,
  publicReadyz,
  runChecks,
  worstStatus,
  type Check,
} from "./health.js";

/** A promise that never settles — stands in for a dependency that has stopped responding. */
const hang = () => new Promise<never>(() => {});

describe("worstStatus", () => {
  it("ranks fail above warn above pass", () => {
    expect(worstStatus(["pass", "warn", "fail"])).toBe("fail");
    expect(worstStatus(["pass", "warn"])).toBe("warn");
    expect(worstStatus(["pass", "pass"])).toBe("pass");
  });

  // An aggregate with nothing to aggregate must not be "fail" — a service with no declared
  // dependencies is healthy, not broken.
  it("treats no checks as pass", () => {
    expect(worstStatus([])).toBe("pass");
  });
});

describe("runChecks", () => {
  it("reports pass for a check that resolves", async () => {
    const out = await runChecks({ db: async () => {} });
    expect(out).toEqual([expect.objectContaining({ name: "db", status: "pass" })]);
  });

  it("honours an explicitly returned warn", async () => {
    const out = await runChecks({ cache: async () => "warn" as const });
    expect(out[0]?.status).toBe("warn");
  });

  // The whole point of a readiness probe is that a broken dependency produces a REPORT, not an
  // exception that takes the endpoint down with it.
  it("converts a throwing check into fail without rejecting", async () => {
    const out = await runChecks({
      db: async () => {
        throw new Error("connection refused");
      },
      r2: async () => {},
    });
    const byName = Object.fromEntries(out.map((o) => [o.name, o.status]));
    expect(byName).toEqual({ db: "fail", r2: "pass" });
  });

  // A hung dependency is the failure mode that a naive health check turns into a hung endpoint,
  // which then looks like a TIMEOUT to the prober rather than a clean 503.
  it("fails a hanging check at the timeout instead of hanging", async () => {
    const started = Date.now();
    const out = await runChecks({ db: hang }, { timeoutMs: 20 });
    expect(out[0]?.status).toBe("fail");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("runs checks concurrently rather than in series", async () => {
    const slow = (): Check => async () => {
      await new Promise((r) => setTimeout(r, 40));
    };
    const started = Date.now();
    await runChecks({ a: slow(), b: slow(), c: slow() }, { timeoutMs: 500 });
    // Serial execution would need >=120ms; concurrent needs ~40ms.
    expect(Date.now() - started).toBeLessThan(120);
  });

  it("records how long each check took", async () => {
    const out = await runChecks({ db: async () => {} });
    expect(out[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out[0]?.durationMs)).toBe(true);
  });
});

describe("healthDocument", () => {
  it("takes the overall status from the worst check", async () => {
    const doc = healthDocument(
      [
        { name: "db", status: "pass", durationMs: 1 },
        { name: "r2", status: "fail", durationMs: 2 },
      ],
      { time: "2026-07-22T00:00:00.000Z" },
    );
    expect(doc.status).toBe("fail");
  });

  // draft-inadarei-api-health-check keys `checks` by "componentName:measurementName".
  it("uses the IETF componentName:measurementName key shape", () => {
    const doc = healthDocument([{ name: "db", status: "pass", durationMs: 7 }], {
      time: "2026-07-22T00:00:00.000Z",
    });
    expect(Object.keys(doc.checks)).toEqual(["db:responseTime"]);
    expect(doc.checks["db:responseTime"]?.[0]).toEqual({
      status: "pass",
      observedValue: 7,
      observedUnit: "ms",
      time: "2026-07-22T00:00:00.000Z",
    });
  });

  it("carries releaseId only when supplied", () => {
    const withId = healthDocument([], { time: "t", releaseId: "abc123" });
    expect(withId.releaseId).toBe("abc123");
    expect(healthDocument([], { time: "t" }).releaseId).toBeUndefined();
  });
});

describe("publicReadyz", () => {
  const doc = (status: "pass" | "warn" | "fail") =>
    healthDocument([{ name: "db", status, durationMs: 3 }], { time: "2026-07-22T00:00:00.000Z" });

  // This asserts on the EXACT serialised bytes. Dependency topology, timings and versions are
  // attack-surface intelligence, so a future field added to the health document must break this
  // test rather than silently start leaking on an unauthenticated endpoint.
  it('serialises to exactly {"status":"pass"} and nothing else', async () => {
    const res = publicReadyz(doc("pass"));
    expect(await res.text()).toBe('{"status":"pass"}');
  });

  it("returns 200 for pass and warn, 503 for fail", () => {
    expect(publicReadyz(doc("pass")).status).toBe(200);
    expect(publicReadyz(doc("warn")).status).toBe(200);
    expect(publicReadyz(doc("fail")).status).toBe(503);
  });

  it("is never cached and never indexed", () => {
    const res = publicReadyz(doc("pass"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("application/health+json; charset=utf-8");
  });
});

describe("authedHealth", () => {
  const doc = healthDocument([{ name: "db", status: "pass", durationMs: 3 }], {
    time: "2026-07-22T00:00:00.000Z",
  });
  const req = (auth?: string) =>
    new Request("https://example.test/health", auth ? { headers: { authorization: auth } } : {});

  // 404 rather than 401: a 401 confirms the endpoint exists, which tells a prober where to aim.
  it("404s an unauthenticated request without confirming the endpoint exists", async () => {
    const res = authedHealth(doc, req(), "s3cret");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("db");
  });

  it("404s a wrong token, and a right token under the wrong scheme", () => {
    expect(authedHealth(doc, req("Bearer wrong"), "s3cret").status).toBe(404);
    expect(authedHealth(doc, req("Basic s3cret"), "s3cret").status).toBe(404);
  });

  it("returns the full document to an authorised caller", async () => {
    const res = authedHealth(doc, req("Bearer s3cret"), "s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "pass",
      checks: { "db:responseTime": [{ status: "pass" }] },
    });
  });

  it("propagates 503 when the document is failing", () => {
    const bad = healthDocument([{ name: "db", status: "fail", durationMs: 1 }], { time: "t" });
    expect(authedHealth(bad, req("Bearer s3cret"), "s3cret").status).toBe(503);
  });

  // An empty configured token must never turn into "any empty header is valid".
  it("refuses every request when no token is configured", () => {
    expect(authedHealth(doc, req("Bearer "), "").status).toBe(404);
    expect(authedHealth(doc, req(), "").status).toBe(404);
  });
});

describe("memoized", () => {
  it("serves a cached value inside the TTL and refreshes after it", async () => {
    let clock = 1_000;
    const fn = vi.fn(async () => clock);
    const cached = memoized(fn, 100, () => clock);

    expect(await cached()).toBe(1_000);
    clock = 1_050;
    expect(await cached()).toBe(1_000); // still inside the TTL
    expect(fn).toHaveBeenCalledTimes(1);

    clock = 1_101; // past the TTL
    expect(await cached()).toBe(1_101);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Without single-flight, a burst of probes against an uncached endpoint becomes a burst of
  // database connections — exactly the amplification the cache exists to prevent.
  it("collapses concurrent calls into a single invocation", async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    });
    const cached = memoized(fn, 1_000);
    const all = await Promise.all([cached(), cached(), cached()]);
    expect(all).toEqual(["v", "v", "v"]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Caching a rejection would pin the endpoint to "broken" for the whole TTL after one blip.
  it("does not cache a rejection", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce("recovered");
    const cached = memoized(fn, 10_000);

    await expect(cached()).rejects.toThrow("blip");
    await expect(cached()).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
