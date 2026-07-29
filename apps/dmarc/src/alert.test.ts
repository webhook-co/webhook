import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_CONFIG,
  evaluateHealth,
  formatAlert,
  isDmarcFailure,
  type EvaluatedRecord,
} from "./alert.js";

const DAY = 86_400;

function record(over: Partial<EvaluatedRecord> = {}): EvaluatedRecord {
  return {
    reportPk: 1,
    orgName: "google.com",
    domain: "webhook.co",
    windowBegin: 1_785_196_800,
    sourceIp: "57.103.64.161",
    msgCount: 1,
    disposition: "none",
    dkimEvaluated: "pass",
    spfEvaluated: "pass",
    headerFrom: "webhook.co",
    ...over,
  };
}

describe("isDmarcFailure", () => {
  it("passes when both mechanisms align", () => {
    expect(isDmarcFailure(record())).toBe(false);
  });

  // THE BUG THIS PREDICATE EXISTS TO AVOID. DMARC passes if EITHER mechanism aligns, so an spf=fail
  // alongside dkim=pass is a PASS. It is also the single most common shape in real data: any forwarder
  // (mailing list, "send a copy to my other address") breaks the SPF path while DKIM survives intact.
  // webhook.co has already seen exactly this — 2026-07-17, source 209.85.220.41, a Gmail forwarding relay.
  // A naive "any mechanism failed" alert fires on every forward, and an alert that cries wolf gets muted,
  // which is strictly worse than no alert at all.
  it("does NOT fire on spf=fail when dkim passes (the forwarding case)", () => {
    expect(isDmarcFailure(record({ spfEvaluated: "fail" }))).toBe(false);
  });

  it("does NOT fire on dkim=fail when spf passes", () => {
    expect(isDmarcFailure(record({ dkimEvaluated: "fail" }))).toBe(false);
  });

  it("fires when BOTH mechanisms fail", () => {
    expect(isDmarcFailure(record({ dkimEvaluated: "fail", spfEvaluated: "fail" }))).toBe(true);
  });

  // A disposition other than `none` means the receiver ACTED on our published policy. That is the
  // receiver telling us, in its own words, that it rejected or quarantined mail carrying our name — the
  // most direct failure signal in the whole report, and it is authoritative regardless of how the two
  // mechanisms happened to evaluate.
  it("fires when the receiver applied quarantine", () => {
    expect(isDmarcFailure(record({ disposition: "quarantine" }))).toBe(true);
  });

  it("fires when the receiver applied reject", () => {
    expect(isDmarcFailure(record({ disposition: "reject" }))).toBe(true);
  });

  // `disposition: none` means "no action taken", NOT `p=none`. Conflating the two would make every
  // healthy record look like a policy downgrade.
  it("treats disposition=none as no action taken, not as p=none", () => {
    expect(isDmarcFailure(record({ disposition: "none" }))).toBe(false);
  });
});

describe("evaluateHealth", () => {
  const now = 1_785_283_199;

  function input(over: Partial<Parameters<typeof evaluateHealth>[0]> = {}) {
    return {
      now,
      records: [record()],
      latestWindowEnd: now - DAY,
      brokenIngestions: 0,
      lastStaleAlertAt: null,
      ...over,
    };
  }

  it("finds nothing when every record passes and reports are current", () => {
    expect(evaluateHealth(input(), DEFAULT_ALERT_CONFIG)).toEqual([]);
  });

  it("reports a dmarc-failure finding carrying only the failing records", () => {
    const bad = record({ reportPk: 2, disposition: "reject", msgCount: 7 });
    const findings = evaluateHealth(
      input({ records: [record(), bad, record({ spfEvaluated: "fail" })] }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "dmarc-failure", totalMessages: 7 });
    expect(findings[0].kind === "dmarc-failure" && findings[0].records).toEqual([bad]);
  });

  it("sums affected messages across several failing records", () => {
    const findings = evaluateHealth(
      input({
        records: [
          record({ disposition: "reject", msgCount: 3 }),
          record({ dkimEvaluated: "fail", spfEvaluated: "fail", msgCount: 4 }),
        ],
      }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings[0]).toMatchObject({ kind: "dmarc-failure", totalMessages: 7 });
  });

  // SILENCE IS THE FAILURE MODE THIS LANE KEEPS HITTING. An absent report cannot be scored as a clean
  // one: if the iCloud -> Cloudflare forward dies, D1 simply stops growing and every failure query keeps
  // returning zero rows. A monitor that only alerts on failures would report perfect health forever.
  it("reports staleness once no report has arrived for longer than the threshold", () => {
    const findings = evaluateHealth(
      input({ latestWindowEnd: now - 20 * DAY }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "stale", daysSinceLatest: 20 });
  });

  // Real reporter cadence is bursty, not daily: webhook.co's own D1 shows windows on 07-16, 07-17, 07-20
  // and 07-28 — an 8-day gap with nothing wrong. The threshold is set from that observed distribution, so
  // a gap that has actually occurred in production must NOT alert.
  it("stays quiet across an 8-day gap, which is normal observed cadence", () => {
    expect(evaluateHealth(input({ latestWindowEnd: now - 8 * DAY }), DEFAULT_ALERT_CONFIG)).toEqual(
      [],
    );
  });

  it("treats never having received a report as stale", () => {
    const findings = evaluateHealth(input({ latestWindowEnd: null }), DEFAULT_ALERT_CONFIG);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "stale" });
  });

  // Staleness persists by nature: once the feed dies it is stale every single day. Re-sending daily would
  // train the reader to filter the alert, so it repeats on a much slower clock than it is evaluated on.
  it("suppresses a repeat staleness alert inside the re-alert interval", () => {
    const findings = evaluateHealth(
      input({ latestWindowEnd: now - 20 * DAY, lastStaleAlertAt: now - DAY }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings).toEqual([]);
  });

  it("repeats a staleness alert once the re-alert interval has elapsed", () => {
    const findings = evaluateHealth(
      input({ latestWindowEnd: now - 60 * DAY, lastStaleAlertAt: now - 30 * DAY }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "stale" });
  });

  // Per migration 0002: `status='parsed' AND is_duplicate=0` with no linked aggregate_report means the
  // report parsed but was never stored. That is data loss, and it is invisible to any DMARC-outcome query
  // precisely because the rows it would have queried are the ones that went missing.
  it("reports broken ingestion independently of dmarc outcomes", () => {
    const findings = evaluateHealth(input({ brokenIngestions: 3 }), DEFAULT_ALERT_CONFIG);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "ingestion-broken", count: 3 });
  });

  it("reports every independent finding at once rather than only the first", () => {
    const findings = evaluateHealth(
      input({
        records: [record({ disposition: "reject" })],
        latestWindowEnd: now - 20 * DAY,
        brokenIngestions: 1,
      }),
      DEFAULT_ALERT_CONFIG,
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "dmarc-failure",
      "ingestion-broken",
      "stale",
    ]);
  });
});

describe("formatAlert", () => {
  const now = 1_785_283_199;

  it("names the domain and the message count in the subject", () => {
    const out = formatAlert(
      [
        {
          kind: "dmarc-failure",
          records: [record({ disposition: "reject", msgCount: 4 })],
          totalMessages: 4,
        },
      ],
      now,
    );
    expect(out.subject).toContain("webhook.co");
    expect(out.subject).toContain("4");
  });

  // The alert has to be actionable from the notification alone — whoever reads it is likely on a phone,
  // away from D1. Source IP is what identifies which sender broke.
  it("includes the source IP and both evaluated mechanisms in the body", () => {
    const out = formatAlert(
      [
        {
          kind: "dmarc-failure",
          records: [
            record({ sourceIp: "203.0.113.7", disposition: "reject", dkimEvaluated: "fail" }),
          ],
          totalMessages: 1,
        },
      ],
      now,
    );
    expect(out.text).toContain("203.0.113.7");
    expect(out.text).toContain("dkim=fail");
    expect(out.text).toContain("reject");
  });

  it("explains what staleness means rather than only stating it", () => {
    const out = formatAlert([{ kind: "stale", daysSinceLatest: 21 }], now);
    expect(out.subject).toMatch(/stale|no report/i);
    expect(out.text).toContain("21");
  });

  it("renders every finding when several fire together", () => {
    const out = formatAlert(
      [
        { kind: "stale", daysSinceLatest: 21 },
        { kind: "ingestion-broken", count: 2 },
      ],
      now,
    );
    expect(out.text).toMatch(/21/);
    expect(out.text).toMatch(/2/);
  });

  it("throws rather than sending an empty alert", () => {
    expect(() => formatAlert([], now)).toThrow();
  });
});
