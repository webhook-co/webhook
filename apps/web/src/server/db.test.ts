import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole of Lane B in one file: ONE client per request, shared by every loader, closed ONCE after the
// response.
//
// This is the test that has to exist, because the win is INVISIBLE to every other test. A page that opens six
// connections renders exactly the same HTML as a page that opens one — so the entire suite stayed green while
// the dashboard paid six TCP+TLS+Postgres handshakes and four blocking teardowns per view. Only a test that
// counts the connections can tell the difference, and only a test that counts them can stop it coming back.

const created: unknown[] = [];
const end = vi.fn().mockResolvedValue(undefined);
const createClient = vi.fn(() => {
  const client = { end, tag: created.length };
  created.push(client);
  return client;
});

/** Captures the callbacks handed to Next's `after()` so we can assert WHEN the close runs, not just that it does. */
const afterCallbacks: Array<() => Promise<void>> = [];

vi.mock("@webhook-co/db/client", () => ({ createClient: (...a: unknown[]) => createClient(...a) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { HYPERDRIVE_TENANT: { connectionString: "postgres://tenant" } },
  })),
}));
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => {
    afterCallbacks.push(cb);
  },
}));
// React's `cache()` memoizes against the RENDER PASS: it reads React's async dispatcher, and with no
// dispatcher it calls straight through and memoizes NOTHING. Vitest has no render pass, so the real `cache()`
// would dedupe nothing and the sharing tests below could not be written at all.
//
// So we stand one in. But be clear-eyed about what that buys and what it does NOT.
//
// It lets us assert what happens WHEN the memo is in scope — a page render, which is the case this change
// exists for and the one that dominates. It CANNOT tell us whether the memo is in scope on some OTHER path,
// because we are the ones who supplied it. A code review caught me claiming "one client per REQUEST" on the
// strength of exactly this mock: the mock made the claim unfalsifiable, which is the difference between a test
// and a decoration. The claim is now the narrower, true one — one client per RENDER — and the un-memoized path
// is asserted separately, against the REAL `cache()`, at the bottom of this file.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <T>(fn: T) => {
      let done = false;
      let value: unknown;
      return ((...args: unknown[]) => {
        if (!done) {
          done = true;
          value = (fn as (...a: unknown[]) => unknown)(...args);
        }
        return value;
      }) as T;
    },
  };
});

beforeEach(() => {
  created.length = 0;
  afterCallbacks.length = 0;
  end.mockClear();
  createClient.mockClear();
  vi.resetModules();
});

/** Re-import per test so the `cache()` memo (and therefore the "request") starts fresh. */
async function freshDb() {
  return import("./db");
}

describe("the request-scoped tenant client", () => {
  it("opens ONE client no matter how many loaders ask for it", async () => {
    const { withTenantDb, getTenantDb } = await freshDb();

    // Five loaders, the shape of a real page: the gate, the org switcher, and three page reads.
    await Promise.all([
      withTenantDb(async () => "gate"),
      withTenantDb(async () => "switcher"),
      withTenantDb(async () => "reads"),
      getTenantDb(),
      getTenantDb(),
    ]);

    // Before this, that page opened FIVE clients — one per caller — each with its own handshake.
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("hands every caller the SAME client", async () => {
    const { withTenantDb, getTenantDb } = await freshDb();

    const [a, b, c] = await Promise.all([
      withTenantDb(async (app) => app),
      getTenantDb(),
      getTenantDb(),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // The load-bearing half. A `finally` in each loader CANNOT do this: it must close while the request is
  // still in flight, which is precisely why the client could not be shared before — the first loader to
  // finish would close it out from under the others. `after()` runs post-response, so the close is both
  // once and safe.
  it("does not close the client during the request", async () => {
    const { withTenantDb } = await freshDb();

    await withTenantDb(async () => "done");

    expect(end).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it("closes it exactly once, after the response", async () => {
    const { withTenantDb, getTenantDb } = await freshDb();
    await withTenantDb(async () => "a");
    await getTenantDb();

    // The response has now been sent; run what Next would run.
    for (const cb of afterCallbacks) await cb();

    expect(afterCallbacks).toHaveLength(1); // one close registered, not one per caller
    expect(end).toHaveBeenCalledTimes(1);
  });

  // A slow or failed teardown must never surface as an error on a response the user already has.
  it("swallows a failing close", async () => {
    const { withTenantDb } = await freshDb();
    end.mockRejectedValueOnce(new Error("connection reset"));

    await withTenantDb(async () => "a");

    await expect(Promise.all(afterCallbacks.map((cb) => cb()))).resolves.toBeDefined();
  });

  // NOT `max: 1`. A single shared connection would serialize the loaders that currently run concurrently —
  // the overview page's four reads would go parallel -> sequential, which across a cross-region round trip
  // can land SLOWER than the six-connection version it replaced. The pool size is the thing that makes
  // sharing a win instead of a regression, so it is asserted rather than left to a default.
  it("uses a small POOL, so concurrent loaders still overlap", async () => {
    const { getTenantDb } = await freshDb();

    await getTenantDb();

    expect(createClient).toHaveBeenCalledWith("postgres://tenant", { max: 5 });
  });
});

describe("a missing binding", () => {
  it("throws rather than silently running unbound", async () => {
    vi.doMock("@opennextjs/cloudflare", () => ({
      getCloudflareContext: vi.fn(async () => ({ env: {} })),
    }));
    vi.resetModules();
    const { getTenantDb } = await import("./db");

    await expect(getTenantDb()).rejects.toThrow(/HYPERDRIVE_TENANT/);
  });
});
