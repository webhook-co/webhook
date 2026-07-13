import { describe, expect, it, vi } from "vitest";

// The route gates on the URL's slug. Stub the gate so the unit runs without a real session/DB — but the stub
// still RECORDS its argument and can be made to REFUSE, so the test asserts the gate is actually invoked with
// the caller's slug and that a refusal blocks the R2 read. (A stub that always succeeds and is never checked
// is exactly how the payload authz went unasserted before.)
const requireOrgAccess = vi.fn(async (slug: string) => ({
  userId: "u",
  orgId: "o",
  slug,
  role: "member" as const,
  user: { name: "", email: "", image: null },
}));
vi.mock("@/server/org-access", () => ({
  requireOrgAccess: (...a: [string, string?]) => requireOrgAccess(...a),
}));

// Mock the R2-reading download opener; keep downloadExtension real (it's pure).
const { openPayloadForDownload } = vi.hoisted(() => ({ openPayloadForDownload: vi.fn() }));
vi.mock("@/server/payloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/payloads")>()),
  openPayloadForDownload,
}));

import { GET } from "./route";

const SLUG = "acme";
const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

function call(id: string, eventId: string, slug: string = SLUG) {
  return GET(new Request("http://app.test/download"), {
    params: Promise.resolve({ slug, id, eventId }),
  });
}

describe("GET payload download route", () => {
  it("streams the body as an attachment with safe headers on success", async () => {
    requireOrgAccess.mockClear();
    openPayloadForDownload.mockReset();
    openPayloadForDownload.mockResolvedValueOnce({
      stream: new ReadableStream(),
      size: 1234,
      contentType: "application/json",
    });
    const res = await call(ENDPOINT_ID, EVENT_ID);

    // The gate ran, with the caller's slug — this is the raw captured body, the most sensitive read in the app.
    expect(requireOrgAccess).toHaveBeenCalledWith(SLUG);

    expect(res.status).toBe(200);
    // forced opaque-bytes download — never the stored content type, never inline
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="event-${EVENT_ID}.json"`,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Length")).toBe("1234");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("does NOT read R2 when the gate refuses a foreign / unknown slug", async () => {
    // requireOrgAccess calls notFound() for a slug outside the caller's directory, which throws. The read must
    // be short-circuited BEFORE any R2 access — a payload byte must never leave the store for a non-member.
    requireOrgAccess.mockClear();
    openPayloadForDownload.mockReset();
    requireOrgAccess.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));

    await expect(call(ENDPOINT_ID, EVENT_ID, "someone-elses-org")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(openPayloadForDownload).not.toHaveBeenCalled();
  });

  it("404s a non-uuid id WITHOUT reading", async () => {
    openPayloadForDownload.mockReset();
    expect((await call("nope", EVENT_ID)).status).toBe(404);
    expect((await call(ENDPOINT_ID, "nope")).status).toBe(404);
    expect(openPayloadForDownload).not.toHaveBeenCalled();
  });

  it("404s when the event/object is not found", async () => {
    openPayloadForDownload.mockReset();
    openPayloadForDownload.mockResolvedValueOnce("not_found");
    expect((await call(ENDPOINT_ID, EVENT_ID)).status).toBe(404);
  });

  it("500s on a read error", async () => {
    openPayloadForDownload.mockReset();
    openPayloadForDownload.mockResolvedValueOnce("error");
    expect((await call(ENDPOINT_ID, EVENT_ID)).status).toBe(500);
  });
});
