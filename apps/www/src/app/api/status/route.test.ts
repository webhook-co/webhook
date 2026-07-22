import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/marketing/status-indicator", () => ({
  fetchStatus: vi.fn(),
}));

import { fetchStatus } from "@/components/marketing/status-indicator";
import { GET } from "./route";

const mocked = vi.mocked(fetchStatus);

describe("GET /api/status", () => {
  it("returns only the two fields the indicator renders", async () => {
    mocked.mockResolvedValueOnce({ message: "Operational", color: "#16a34a" });
    const res = await GET();
    expect(res.status).toBe(200);
    // Narrowed, not forwarded: the vendor body also carries an inline logoSvg and label colours we
    // neither use nor want to hand to a browser under our own origin.
    expect(await res.json()).toEqual({ message: "Operational", color: "#16a34a" });
  });

  // A degraded vendor must not become a 5xx in our logs or a red line in the console.
  it("returns 204, never an error, when there is nothing trustworthy", async () => {
    mocked.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("is cacheable and carries no per-visitor data", async () => {
    mocked.mockResolvedValueOnce({ message: "Operational", color: "#16a34a" });
    const cc = (await GET()).headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
    expect(cc).toContain("stale-while-revalidate");
  });
});
