import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared limiter so we can drive the allow / deny / KV-fault outcomes and pin the fail-open (send) vs
// fail-closed (verify) posture — swapping those catches would either block login or reopen OTP guessing.
const { consumeRateLimit } = vi.hoisted(() => ({ consumeRateLimit: vi.fn() }));
vi.mock("./rate-limit", () => ({ consumeRateLimit }));

import { rateLimitSendAllowed, rateLimitVerifyAllowed } from "./email-change-deps";

const deps = { kv: {} as never, nowSeconds: () => 0 };

beforeEach(() => vi.clearAllMocks());

describe("rateLimitSendAllowed (fails OPEN)", () => {
  it("returns the limiter's verdict when it responds", async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: true });
    expect(await rateLimitSendAllowed(deps, "u1")).toBe(true);
    consumeRateLimit.mockResolvedValueOnce({ allowed: false });
    expect(await rateLimitSendAllowed(deps, "u1")).toBe(false);
  });

  it("FAILS OPEN (true) when the KV limiter throws — availability beats a strict cap on a blip", async () => {
    consumeRateLimit.mockRejectedValueOnce(new Error("kv down"));
    expect(await rateLimitSendAllowed(deps, "u1")).toBe(true);
  });
});

describe("rateLimitVerifyAllowed (fails CLOSED)", () => {
  it("returns the limiter's verdict when it responds", async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: true });
    expect(await rateLimitVerifyAllowed(deps, "u1")).toBe(true);
    consumeRateLimit.mockResolvedValueOnce({ allowed: false });
    expect(await rateLimitVerifyAllowed(deps, "u1")).toBe(false);
  });

  it("FAILS CLOSED (false) when the KV limiter throws — a fault must not open an OTP-guessing window", async () => {
    consumeRateLimit.mockRejectedValueOnce(new Error("kv down"));
    expect(await rateLimitVerifyAllowed(deps, "u1")).toBe(false);
  });
});
