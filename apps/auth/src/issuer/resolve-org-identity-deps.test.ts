import { describe, expect, it, vi } from "vitest";

import { resolveOrgIdentityRpc } from "./resolve-org-identity-deps";

// The DB read itself (readOrgIdentity) is covered in packages/db. Here we pin the auth-boundary FLOOR: an
// empty/absent orgId fails closed BEFORE a pool is ever opened, so a degenerate caller can't turn the org
// read into an unkeyed probe (and avoids a needless connection).
vi.mock("@webhook-co/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@webhook-co/db")>();
  return {
    ...actual,
    createClient: vi.fn(() => {
      throw new Error("createClient must not be called when the orgId is empty");
    }),
  };
});

describe("resolveOrgIdentityRpc", () => {
  const env = { HYPERDRIVE_TENANT: { connectionString: "postgres://unused" } };

  it("fails closed on an empty orgId — returns null without opening a pool", async () => {
    await expect(resolveOrgIdentityRpc(env, "")).resolves.toBeNull();
  });
});
