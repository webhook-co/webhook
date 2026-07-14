import { beforeEach, describe, expect, it, vi } from "vitest";

// The path `db.test.ts` structurally CANNOT see — so it gets its own file, with React DELIBERATELY NOT MOCKED.
//
// `db.test.ts` stands in a memo for React's `cache()`, because vitest has no render pass and the real `cache()`
// would dedupe nothing there. That is a legitimate way to assert what happens WHEN the memo is in scope. What
// it cannot do — because it supplied the memo itself — is tell you what happens when the memo is NOT in scope.
// A code review caught exactly that: "one client per request" was asserted against a mock that guaranteed it.
//
// React's `cache()` memoizes against the RENDER PASS. It reads React's async dispatcher, and with no dispatcher
// it calls straight through and memoizes nothing. Next installs that dispatcher for the RSC render — but a
// SERVER ACTION body runs before it. So on the mutation path there is no memo, and each caller gets its own
// client.
//
// Two things follow, and this file pins both:
//
//   1. The honest headline is "one client per RENDER", not per request. Page views (several loaders deep) get
//      the win; actions do not.
//   2. It is NOT a regression, and nothing leaks: every caller that opens a client registers its own close.
//      N callers -> N clients -> exactly N closes. That is precisely what the pre-change code did on EVERY
//      path, so the mutation path is left no worse than it was.

const end = vi.fn().mockResolvedValue(undefined);
const createClient = vi.fn(() => ({ end }));
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
// NOTE: `react` is NOT mocked here. That absence is the entire point of this file.

beforeEach(() => {
  afterCallbacks.length = 0;
  end.mockClear();
  createClient.mockClear();
  vi.resetModules();
});

describe("outside a render pass — a server action, where cache() does not memoize", () => {
  it("gives each caller its own client, and closes EVERY one of them", async () => {
    const { getTenantDb } = await import("./db");

    const a = await getTenantDb();
    const b = await getTenantDb();
    const c = await getTenantDb();

    // No render pass, so no memo, so no sharing. Stated out loud instead of quietly assumed away.
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);

    // The invariant that holds on EVERY path: one close per client opened. Not one close for three clients
    // (which would leak two connections), and not three closes for one client (which would tear a live client
    // out from under its users).
    expect(afterCallbacks).toHaveLength(3);
    for (const cb of afterCallbacks) await cb();
    expect(end).toHaveBeenCalledTimes(3);
  });

  it("still never closes a client DURING the request, even unmemoized", async () => {
    const { withTenantDb } = await import("./db");

    await withTenantDb(async () => "work");

    expect(end).not.toHaveBeenCalled();
  });
});
