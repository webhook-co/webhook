import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import {
  beatKey,
  isRegisteredJob,
  jobChecks,
  jobStatus,
  parseBeat,
  REGISTERED_JOBS,
  type BeatStore,
  type JobSpec,
} from "./heartbeat";

const spec: JobSpec = { id: "anchor", windowMs: 1000, label: "test" };

const store = (entries: Record<string, string>): BeatStore => ({
  get: async (key) => entries[key] ?? null,
});

describe("jobStatus", () => {
  it("passes a job that reported successfully inside its window", () => {
    expect(jobStatus(spec, { ts: 500, ok: true }, 1000)).toBe("pass");
  });

  // The whole point of a dead-man's switch: silence is the alarm.
  it("fails a job whose last report is older than its window", () => {
    expect(jobStatus(spec, { ts: 0, ok: true }, 1001)).toBe("fail");
  });

  it("treats the window boundary as still healthy", () => {
    expect(jobStatus(spec, { ts: 0, ok: true }, 1000)).toBe("pass");
  });

  // A job that ran and failed is a different fact from one that never ran, but both are `fail`:
  // neither did the work.
  it("fails a job that reported a failed run", () => {
    expect(jobStatus(spec, { ts: 1000, ok: false }, 1000)).toBe("fail");
  });

  // Grading a never-seen job `warn` would let a permanently dead cron sit yellow forever.
  it("fails a job that has never reported at all", () => {
    expect(jobStatus(spec, null, 1000)).toBe("fail");
  });
});

describe("parseBeat", () => {
  it("round-trips a well-formed beat", () => {
    expect(parseBeat('{"ts":123,"ok":true}')).toEqual({ ts: 123, ok: true });
  });

  // Malformed storage must read as "no evidence", never as a crash and never as healthy.
  it.each([
    ["absent", null],
    ["not json", "{{{"],
    ["not an object", "42"],
    ["null", "null"],
    ["missing ts", '{"ok":true}'],
    ["non-numeric ts", '{"ts":"x","ok":true}'],
    ["NaN ts", '{"ts":null,"ok":true}'],
    ["missing ok", '{"ts":1}'],
    ["non-boolean ok", '{"ts":1,"ok":"yes"}'],
  ])("treats a %s beat as absent", (_label, raw) => {
    expect(parseBeat(raw as string | null)).toBeNull();
  });
});

describe("the registered job list", () => {
  it("has unique, slug-safe ids", () => {
    const ids = REGISTERED_JOBS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("gives every job a window and a human-readable label", () => {
    for (const j of REGISTERED_JOBS) {
      expect(j.windowMs).toBeGreaterThan(0);
      expect(j.label.length).toBeGreaterThan(10);
    }
  });

  // An hourly job must tolerate one missed run; two in a row is a pattern, not a blip.
  it("sets every window to at least twice its schedule", () => {
    const hourly = REGISTERED_JOBS.filter((j) => j.label.includes("hourly"));
    expect(hourly.length).toBeGreaterThan(0);
    for (const j of hourly) expect(j.windowMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("accepts only registered ids", () => {
    expect(isRegisteredJob("anchor")).toBe(true);
    expect(isRegisteredJob("../../etc/passwd")).toBe(false);
    expect(isRegisteredJob("")).toBe(false);
  });
});

describe("jobChecks", () => {
  it("produces one check per registered job", () => {
    expect(Object.keys(jobChecks(store({})))).toEqual(REGISTERED_JOBS.map((j) => j.id));
  });

  it("passes only when every job has reported inside its window", async () => {
    const now = 10_000_000;
    const fresh = Object.fromEntries(
      REGISTERED_JOBS.map((j) => [beatKey(j.id), JSON.stringify({ ts: now - 1000, ok: true })]),
    );
    const outcomes = await runChecks(
      jobChecks(store(fresh), () => now),
      { timeoutMs: 500 },
    );
    expect(outcomes.every((o) => o.status === "pass")).toBe(true);
  });

  // The failure must NAME the job, or an operator learns only that "something" stopped.
  it("names the specific job that went silent", async () => {
    const now = 10_000_000;
    const entries = Object.fromEntries(
      REGISTERED_JOBS.map((j) => [beatKey(j.id), JSON.stringify({ ts: now - 1000, ok: true })]),
    );
    entries[beatKey("meter-rollup")] = JSON.stringify({ ts: now - 99 * 60 * 60 * 1000, ok: true });
    const outcomes = await runChecks(
      jobChecks(store(entries), () => now),
      { timeoutMs: 500 },
    );
    const failed = outcomes.filter((o) => o.status === "fail").map((o) => o.name);
    expect(failed).toEqual(["meter-rollup"]);
  });

  it("fails every job on an empty store", async () => {
    const outcomes = await runChecks(
      jobChecks(store({}), () => 0),
      { timeoutMs: 500 },
    );
    expect(outcomes.every((o) => o.status === "fail")).toBe(true);
  });
});
