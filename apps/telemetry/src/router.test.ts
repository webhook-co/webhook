import { describe, expect, it } from "vitest";

import { handleTelemetry, parseEvent, type Env } from "./router.js";

const VALID = {
  v: "0.1.2",
  os: "darwin",
  arch: "arm64",
  command: "events list",
  outcome: "ok",
  exit: 0,
  duration: "<1s",
};

function fakeEnv() {
  const points: unknown[] = [];
  const env: Env = {
    TELEMETRY: {
      writeDataPoint: (p: unknown) => void points.push(p),
    } as unknown as Env["TELEMETRY"],
  };
  return { env, points };
}

const post = (body: unknown): Request =>
  new Request("https://telemetry.wbhk.my/e", { method: "POST", body: JSON.stringify(body) });

describe("parseEvent", () => {
  it("accepts a well-formed anonymous event", () => {
    expect(parseEvent(VALID)).toEqual(VALID);
  });

  it("rejects missing / wrong-typed fields", () => {
    expect(parseEvent({ ...VALID, v: undefined })).toBeNull();
    expect(parseEvent({ ...VALID, exit: "0" })).toBeNull();
    expect(parseEvent({ ...VALID, command: "" })).toBeNull();
    expect(parseEvent("nope")).toBeNull();
    expect(parseEvent(null)).toBeNull();
  });

  it("rejects oversized fields (bounded — no arbitrary blobs)", () => {
    expect(parseEvent({ ...VALID, command: "x".repeat(65) })).toBeNull();
    expect(parseEvent({ ...VALID, v: "x".repeat(33) })).toBeNull();
  });

  it("rejects control characters in strings", () => {
    expect(parseEvent({ ...VALID, command: "events\nlist" })).toBeNull();
    expect(parseEvent({ ...VALID, os: "darwin" })).toBeNull();
  });

  it("rejects a non-POSIX exit code (out of 0..255 or non-integer)", () => {
    expect(parseEvent({ ...VALID, exit: 1e308 })).toBeNull();
    expect(parseEvent({ ...VALID, exit: 1.5 })).toBeNull();
    expect(parseEvent({ ...VALID, exit: -1 })).toBeNull();
    expect(parseEvent({ ...VALID, exit: 64 })).toEqual({ ...VALID, exit: 64 });
  });

  it("drops extra fields (only the known shape is kept)", () => {
    expect(parseEvent({ ...VALID, secret: "leak", token: "whk_x" })).toEqual(VALID);
  });
});

describe("handleTelemetry", () => {
  it("writes one Analytics Engine data point for a valid POST /e and returns 204", async () => {
    const { env, points } = fakeEnv();
    const res = await handleTelemetry(post(VALID), env);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      blobs: ["0.1.2", "darwin", "arm64", "events list", "ok", "<1s"],
      doubles: [0],
      indexes: ["events list"],
    });
  });

  it("drops an invalid body (204, no write)", async () => {
    const { env, points } = fakeEnv();
    expect((await handleTelemetry(post({ junk: true }), env)).status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it("404s a non-POST or a wrong path", async () => {
    const { env } = fakeEnv();
    expect((await handleTelemetry(new Request("https://telemetry.wbhk.my/e"), env)).status).toBe(
      404,
    );
    expect(
      (await handleTelemetry(new Request("https://telemetry.wbhk.my/x", { method: "POST" }), env))
        .status,
    ).toBe(404);
  });

  it("does not crash on an unparseable body (204, no write)", async () => {
    const { env, points } = fakeEnv();
    const bad = new Request("https://telemetry.wbhk.my/e", { method: "POST", body: "{not json" });
    expect((await handleTelemetry(bad, env)).status).toBe(204);
    expect(points).toHaveLength(0);
  });
});
