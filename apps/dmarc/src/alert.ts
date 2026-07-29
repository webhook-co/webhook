/**
 * DMARC health evaluation — the watcher for the ingestion pipeline (Phase 5 follow-on).
 *
 * WHY THIS EXISTS: all three lanes sit at `p=reject`. A sender that falls out of alignment gets its mail
 * REJECTED, not quarantined — and for `mail.webhook.co` that mail is the magic link, i.e. login. Until
 * this module existed, D1 collected the evidence and nothing read it: the entire detection mechanism was
 * a human noticing a forwarded PDF. That is a person, not a control.
 *
 * Everything here is PURE — it takes already-fetched rows and returns findings. The D1 queries and the
 * notification live in index.ts. That split is what lets the two subtle rules below be tested directly,
 * and both of them are rules this repo has already been bitten by:
 *
 *   1. DMARC passes if EITHER mechanism aligns. Alerting on "a mechanism failed" fires on every forwarded
 *      message, and an alert that cries wolf gets muted.
 *   2. Absent data is not clean data. A dead feed produces zero failing rows forever.
 */

/** One evaluated record from an aggregate report, joined to the window it arrived in. */
export interface EvaluatedRecord {
  reportPk: number;
  orgName: string;
  domain: string;
  /** `aggregate_report.date_begin`, unix seconds. */
  windowBegin: number;
  sourceIp: string;
  msgCount: number;
  /** What the receiver DID: `none` | `quarantine` | `reject`. `none` means no action, NOT `p=none`. */
  disposition: string;
  dkimEvaluated: string;
  spfEvaluated: string;
  headerFrom: string;
}

export type Finding =
  | { kind: "dmarc-failure"; records: EvaluatedRecord[]; totalMessages: number }
  | { kind: "stale"; daysSinceLatest: number }
  | { kind: "ingestion-broken"; count: number };

export interface AlertConfig {
  /** No report window newer than this many seconds ⇒ the feed is presumed dead. */
  stalenessSeconds: number;
  /** Minimum gap between two staleness alerts. Staleness persists, so it must not repeat daily. */
  staleRealertSeconds: number;
}

const DAY = 86_400;

/**
 * Thresholds are derived from webhook.co's OBSERVED reporter cadence, not guessed. D1 holds windows on
 * 2026-07-16, 07-17, 07-20 and 07-28 — a maximum healthy gap of 8 days, because Google emits a report
 * only when it saw traffic and this domain is pre-launch. 14 days clears that with headroom.
 *
 * Erring long is deliberate: a false staleness alert teaches the reader to ignore the channel, which
 * costs more than the extra days of detection latency. Revisit once launch volume makes reports daily —
 * at that point 14 days would be far too slack and should come down.
 */
export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  stalenessSeconds: 14 * DAY,
  staleRealertSeconds: 7 * DAY,
};

/**
 * Did this record fail DMARC?
 *
 * TWO independent ways to fail, and the OR between them is load-bearing:
 *
 *   - The receiver applied a policy (`disposition !== "none"`). This is authoritative: the receiver is
 *     telling us it acted on mail carrying our name.
 *   - BOTH mechanisms failed to align. DMARC needs only one, so this is the real "unauthenticated" case.
 *
 * The inverse is what matters most in practice: `spf=fail` with `dkim=pass` is a PASS. Every forwarder
 * breaks the SPF path while DKIM survives, and webhook.co has already logged exactly that shape
 * (2026-07-17, `209.85.220.41`, a Gmail forwarding relay).
 */
export function isDmarcFailure(
  r: Pick<EvaluatedRecord, "disposition" | "dkimEvaluated" | "spfEvaluated">,
): boolean {
  if (r.disposition !== "none") return true;
  return r.dkimEvaluated !== "pass" && r.spfEvaluated !== "pass";
}

export interface HealthInput {
  /** Unix seconds. */
  now: number;
  /** Records not yet alerted on. Caller bounds this by the last alerted report id. */
  records: EvaluatedRecord[];
  /** `MAX(aggregate_report.date_end)`, or null if no report has EVER been ingested. */
  latestWindowEnd: number | null;
  /** Messages that parsed but were never stored, per migration 0002. Data loss, not a DMARC outcome. */
  brokenIngestions: number;
  /** Unix seconds of the last staleness alert, for the re-alert clock. */
  lastStaleAlertAt: number | null;
}

/**
 * Evaluate every health dimension and return ALL findings, not the first.
 *
 * They are genuinely independent: the feed can be stale while the last records it did deliver were
 * failing, and ingestion can be dropping reports while the ones that survive look clean. Returning only
 * the first finding would let one problem mask another.
 */
export function evaluateHealth(input: HealthInput, config: AlertConfig): Finding[] {
  const findings: Finding[] = [];

  const failing = input.records.filter(isDmarcFailure);
  if (failing.length > 0) {
    findings.push({
      kind: "dmarc-failure",
      records: failing,
      totalMessages: failing.reduce((sum, r) => sum + r.msgCount, 0),
    });
  }

  // A null `latestWindowEnd` means no report has ever landed. That is the alarming end of the scale, not
  // a benign "nothing to compare against" — it says the pipeline has never once worked.
  const secondsSince =
    input.latestWindowEnd === null ? Infinity : input.now - input.latestWindowEnd;
  if (secondsSince > config.stalenessSeconds) {
    const quiet =
      input.lastStaleAlertAt !== null &&
      input.now - input.lastStaleAlertAt < config.staleRealertSeconds;
    if (!quiet) {
      findings.push({
        kind: "stale",
        daysSinceLatest: Number.isFinite(secondsSince) ? Math.floor(secondsSince / DAY) : Infinity,
      });
    }
  }

  if (input.brokenIngestions > 0) {
    findings.push({ kind: "ingestion-broken", count: input.brokenIngestions });
  }

  return findings;
}

function isoDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Render findings into a notification.
 *
 * Written to be actionable from the notification alone — whoever reads it is probably on a phone, not in
 * front of D1 — so the source IP, both evaluated mechanisms and the affected window all appear inline.
 */
export function formatAlert(findings: Finding[], now: number): { subject: string; text: string } {
  // Sending an empty alert would be worse than silence: it is a channel teaching its reader that its
  // messages mean nothing. A caller reaching here with no findings is a bug, so say so loudly.
  if (findings.length === 0) {
    throw new Error("formatAlert called with no findings — refusing to send an empty alert");
  }

  const domains = new Set<string>();
  const sections: string[] = [];
  const headlines: string[] = [];

  for (const f of findings) {
    if (f.kind === "dmarc-failure") {
      for (const r of f.records) domains.add(r.domain);
      headlines.push(`${f.totalMessages} message(s) failed DMARC`);
      const lines = f.records.map(
        (r) =>
          `  ${isoDay(r.windowBegin)}  ${r.sourceIp}  x${r.msgCount}  ` +
          `disposition=${r.disposition}  dkim=${r.dkimEvaluated}  spf=${r.spfEvaluated}  ` +
          `header.from=${r.headerFrom}  (reported by ${r.orgName})`,
      );
      sections.push(
        [
          `DMARC FAILURES (${f.totalMessages} message(s))`,
          "",
          "A receiver either acted on our policy, or both mechanisms failed to align.",
          "All three lanes are at p=reject, so failing mail is REJECTED, not quarantined.",
          "",
          ...lines,
        ].join("\n"),
      );
    } else if (f.kind === "stale") {
      const days = Number.isFinite(f.daysSinceLatest) ? String(f.daysSinceLatest) : "never";
      headlines.push("no reports arriving");
      sections.push(
        [
          `NO REPORTS FOR ${days} DAY(S)`,
          "",
          "Absent data is NOT clean data. Every DMARC-failure query returns zero rows when the",
          "feed is dead, so silence here looks identical to perfect health.",
          "",
          "Check, in order: the iCloud rule forwarding to reports@wbhk.my, the Cloudflare Email",
          "Routing rule, and inbound_message for rows with status='rejected'.",
        ].join("\n"),
      );
    } else {
      headlines.push(`${f.count} report(s) not stored`);
      sections.push(
        [
          `INGESTION BROKEN — ${f.count} message(s) parsed but never stored`,
          "",
          "These rows read status='parsed', is_duplicate=0 and link to no aggregate_report, which",
          "per migration 0002 means exactly one thing: the report was understood and then lost.",
        ].join("\n"),
      );
    }
  }

  const scope = domains.size === 1 ? [...domains][0] : "webhook.co";
  const subject = `[dmarc] ${scope}: ${headlines.join("; ")}`;

  const text = [
    `DMARC health check — ${new Date(now * 1000).toISOString()}`,
    "",
    ...sections.flatMap((s) => [s, ""]),
    "---",
    "Sent by the webhook-co dmarc Worker's scheduled health check.",
    "Records live in the webhook-dmarc D1 database (aggregate_report / aggregate_record).",
  ].join("\n");

  return { subject, text };
}
