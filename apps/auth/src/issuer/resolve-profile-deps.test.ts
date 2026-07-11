import { describe, expect, it, vi } from "vitest";

import { resolveProfileRpc } from "./resolve-profile-deps";

// The DB read itself (getAuthUserProfile) is covered in packages/db. Here we pin the auth-boundary FLOOR:
// an empty/absent userId fails closed BEFORE a pool is ever opened, so a degenerate caller can't turn the
// PII-read primitive into an unkeyed realm probe.
vi.mock("@webhook-co/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@webhook-co/db")>();
  return {
    ...actual,
    createClient: vi.fn(() => {
      throw new Error("createClient must not be called when the userId is empty");
    }),
  };
});

describe("resolveProfileRpc", () => {
  const env = { HYPERDRIVE_AUTH: { connectionString: "postgres://unused" } };

  it("fails closed on an empty userId — returns null without opening a pool", async () => {
    await expect(resolveProfileRpc(env, "")).resolves.toBeNull();
  });
});
