import { describe, expect, it, vi } from "vitest";

// The route gates on the session; stub it so the unit runs without a cookie.
vi.mock("@/server/session", () => ({
  verifySession: vi.fn(async () => ({
    userId: "u",
    orgId: "o",
    user: { name: "", email: "", image: null },
  })),
}));

// Mock the R2-reading download opener; keep downloadExtension real (it's pure).
const { openPayloadForDownload } = vi.hoisted(() => ({ openPayloadForDownload: vi.fn() }));
vi.mock("@/server/payloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/payloads")>()),
  openPayloadForDownload,
}));

import { GET } from "./route";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

function call(id: string, eventId: string) {
  return GET(new Request("http://app.test/download"), { params: Promise.resolve({ id, eventId }) });
}

describe("GET payload download route", () => {
  it("streams the body as an attachment with safe headers on success", async () => {
    openPayloadForDownload.mockReset();
    openPayloadForDownload.mockResolvedValueOnce({
      stream: new ReadableStream(),
      size: 1234,
      contentType: "application/json",
    });
    const res = await call(ENDPOINT_ID, EVENT_ID);
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
