import { beforeEach, describe, expect, it, vi } from "vitest";

// The org directory is read by TWO callers on every gated page: the gate (`requireOrgAccess`, to resolve the
// URL's slug inside the caller's own memberships) and the org switcher (`loadMyOrgs`, to fill the picker).
//
// They used to be separate reads. The gate was memoized; the switcher was not — so it re-issued the IDENTICAL
// `user_org_directory()` query on a SECOND connection, on every single page of the dashboard. And because the
// layout ran them together in a `Promise.all`, the duplication was concurrent and therefore invisible in
// wall-clock: it just quietly doubled the load, and no test noticed, because both callers returned the right
// answer.
//
// That is the failure mode this file exists for. It is the ONLY test that can see the difference between "one
// query" and "two queries that agree with each other".

const listUserOrgs = vi.fn();
vi.mock("@webhook-co/db/orgs", () => ({ listUserOrgs: (...a: unknown[]) => listUserOrgs(...a) }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

// React's `cache()` memoizes per REQUEST, and outside a request it is a pass-through — so under vitest it
// would dedupe nothing and this test would be asserting against a scope that does not exist. Stand in a
// per-key memo, which IS the semantics production depends on (same key, same value, computed once). The
// codebase already leans on this exact behaviour: `resolveOrgAccess` is memoized so the layout and the page
// share one directory round-trip.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <T>(fn: T) => {
      const memo = new Map<string, unknown>();
      return ((...args: unknown[]) => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) memo.set(key, (fn as (...a: unknown[]) => unknown)(...args));
        return memo.get(key);
      }) as T;
    },
  };
});

const ORGS = [{ orgId: "o1", slug: "alpha", name: "Alpha", role: "owner", formerSlugs: [] }];

beforeEach(() => {
  vi.resetModules();
  listUserOrgs.mockReset();
  listUserOrgs.mockResolvedValue(ORGS);
});

describe("readUserOrgDirectory", () => {
  it("queries the database ONCE however many callers ask, within a request", async () => {
    const { readUserOrgDirectory } = await import("./org-directory");

    // The gate and the switcher, exactly as the layout runs them — concurrently.
    const [a, b, c] = await Promise.all([
      readUserOrgDirectory("usr_1"),
      readUserOrgDirectory("usr_1"),
      readUserOrgDirectory("usr_1"),
    ]);

    expect(listUserOrgs).toHaveBeenCalledTimes(1);
    expect(a).toEqual(ORGS);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // The memo is keyed on userId, and that is not a detail: a key that omitted it would hand one user another
  // user's org list — a cross-tenant leak rather than a mere inefficiency. So a DIFFERENT user must miss.
  it("never serves one user's directory to another", async () => {
    const { readUserOrgDirectory } = await import("./org-directory");
    const other = [{ orgId: "o2", slug: "beta", name: "Beta", role: "member", formerSlugs: [] }];
    listUserOrgs.mockResolvedValueOnce(ORGS).mockResolvedValueOnce(other);

    const mine = await readUserOrgDirectory("usr_1");
    const theirs = await readUserOrgDirectory("usr_2");

    expect(listUserOrgs).toHaveBeenCalledTimes(2); // a different user is a different question
    expect(mine).toEqual(ORGS);
    expect(theirs).toEqual(other);
    expect(listUserOrgs).toHaveBeenNthCalledWith(1, {}, "usr_1");
    expect(listUserOrgs).toHaveBeenNthCalledWith(2, {}, "usr_2");
  });
});
