import { describe, expect, it } from "vitest";

import { renderUsageThresholdEmail, type UsageThresholdContext } from "./usage-threshold-email";

const BASE: UsageThresholdContext = {
  usage: 8_000,
  eventCap: 10_000,
  threshold: 80,
  pausePolicy: "pause",
  periodEndIso: "2026-08-01T00:00:00.000Z",
};

describe("renderUsageThresholdEmail", () => {
  it("renders an approaching-limit (80%) heads-up with the org's own numbers and reset date", () => {
    const email = renderUsageThresholdEmail(BASE);
    expect(email.subject).toBe("You've used 80% of your included events");
    // The org's own usage/cap, thousands-formatted, in both HTML and text.
    expect(email.html).toContain("8,000 of 10,000 events (80%)");
    expect(email.text).toContain("8,000 of 10,000 events (80%)");
    expect(email.html).toContain("Aug 1, 2026"); // reset date, deterministic UTC
    // A pause-policy org is told the consequence at 100%.
    expect(email.text).toContain("paused until your limit resets");
  });

  it("at 100% + pause is honest that capture is PAUSED (no 'nothing was lost')", () => {
    const email = renderUsageThresholdEmail({
      ...BASE,
      usage: 10_000,
      threshold: 100,
    });
    expect(email.subject).toBe("You've reached your event limit — capture is paused");
    expect(email.text).toContain("new events are paused");
    expect(email.text).toContain("10,000 of 10,000 events (100%)");
  });

  it("at 100% + allow describes overage (never a pause) instead", () => {
    const email = renderUsageThresholdEmail({
      ...BASE,
      usage: 12_000,
      threshold: 100,
      pausePolicy: "allow",
    });
    expect(email.subject).toBe("You've reached your included event limit");
    expect(email.text).toContain("captured as overage");
    expect(email.text).not.toContain("paused");
    // The percentage is clamped to 100 even when usage exceeds the cap.
    expect(email.text).toContain("12,000 of 10,000 events (100%)");
  });

  it("carries NO price or currency (single dimension = the org's own event counts)", () => {
    const email = renderUsageThresholdEmail(BASE);
    expect(email.html).not.toMatch(/\$|USD|€|\bprice\b|\bcost\b/i);
    expect(email.text).not.toMatch(/\$|USD|€|\bprice\b|\bcost\b/i);
  });

  it("degrades to a sane reset phrase on an unparseable period end", () => {
    const email = renderUsageThresholdEmail({ ...BASE, periodEndIso: "not-a-date" });
    expect(email.text).toContain("the start of your next billing period");
  });

  it("produces a valid standalone HTML document + a plain-text alternative", () => {
    const email = renderUsageThresholdEmail(BASE);
    expect(email.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(email.html).toContain("app.webhook.co/usage"); // the CTA
    expect(email.text.length).toBeGreaterThan(0);
  });
});
