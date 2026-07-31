// reports@wbhk.my — the DMARC aggregate-report ingestion Worker (ADR-0021, Phase 1).
//
// An EMAIL Worker, not a fetch Worker: no HTTP surface at all. Bound via an Email Routing rule.
//
// Thin by design — selection lives in ingest.ts and decoding in report.ts, both pure and unit-tested.
// What lives here is the part that cannot be unit-tested without workerd: the message stream and D1.
//
// THE ONE RULE HERE: record the message BEFORE trying to understand it, and never throw away a message we
// could not parse. This pipeline's worst failure is not a crash — it is looking healthy while empty. The
// runbook's section 3 hop (iCloud auto-forwards the report to us) is UNPROVEN, and forwarding is exactly
// what breaks SPF. If that hop dies, `inbound_message` simply stays empty, and "empty" must mean "nothing
// arrived" and nothing else. So every arrival gets a row, including rejects, with the reason attached.
//
// We deliberately do NOT reply, bounce, or forward: replying would make Cloudflare send as wbhk.my, which
// would force CF's SPF include onto the zone and undo the Phase 3 anti-spoof posture (`v=spf1 -all`).

import PostalMime from "postal-mime";

import {
  DEFAULT_ALERT_CONFIG,
  evaluateHealth,
  formatAlert,
  type EvaluatedRecord,
} from "./alert.js";
import { selectReportAttachment, type CandidateAttachment } from "./ingest.js";
import { sendAlert } from "./notify.js";
import { decompressReport, parseAggregateReport, ReportError } from "./report.js";

export interface Env {
  DMARC_DB: D1Database;
  /** Resend API key. A SECRET — set with `wrangler secret put`, never in wrangler.jsonc. */
  RESEND_API_KEY: string;
  /** Where alerts go. A SECRET too: it is a personal address and this repo is public. */
  ALERT_TO: string;
  /**
   * Local-dev opt-out, mirroring apps/auth. "log" prints the alert instead of sending it, for a
   * contributor who cannot hold a Resend key. Absent everywhere else — `scripts/dev-mode-guard.mjs`
   * refuses a mode flag on any deployed Worker, so production cannot silently stop alerting.
   */
  EMAIL_MODE?: string;
}

/** Hard ceiling on the raw message we will buffer. Real aggregates are single-digit KB; the mailbox is
 *  public, so this bounds what an unsolicited sender can make us hold in memory. */
const MAX_RAW_BYTES = 12 * 1024 * 1024;

async function readRaw(message: ForwardableEmailMessage): Promise<Uint8Array> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RAW_BYTES) {
      await reader.cancel();
      throw new ReportError("raw message exceeds cap");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function recordMessage(
  env: Env,
  row: {
    mailFrom: string;
    rcptTo: string;
    subject: string | null;
    authResults: string | null;
    attachments: string;
    rawBytes: number;
    status: "parsed" | "rejected";
    error: string | null;
  },
): Promise<number> {
  const res = await env.DMARC_DB.prepare(
    `INSERT INTO inbound_message
       (received_at, mail_from, rcpt_to, subject, auth_results, attachments, raw_bytes, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      new Date().toISOString(),
      row.mailFrom,
      row.rcptTo,
      row.subject,
      row.authResults,
      row.attachments,
      row.rawBytes,
      row.status,
      row.error,
    )
    .first<{ id: number }>();

  if (!res) throw new Error("failed to record inbound_message");
  return res.id;
}

/** The address alerts are sent FROM. Any local part works on an already-verified Resend domain, so this
 *  needs no capability change on `mail.webhook.co` — see the 2026-07-14 incident in the build plan. */
const ALERT_FROM = "dmarc-alerts@mail.webhook.co";

async function readState(env: Env, key: string): Promise<number | null> {
  const row = await env.DMARC_DB.prepare(`SELECT value FROM alert_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

async function writeState(env: Env, key: string, value: number): Promise<void> {
  await env.DMARC_DB.prepare(
    `INSERT INTO alert_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, String(value))
    .run();
}

interface HealthSnapshot {
  records: EvaluatedRecord[];
  latestWindowEnd: number | null;
  brokenIngestions: number;
  maxReportPk: number;
  cursor: number;
  lastStaleAlertAt: number | null;
}

/** Read everything the evaluation needs in one place, so `scheduled` stays about orchestration. */
async function readSnapshot(env: Env): Promise<HealthSnapshot> {
  const cursor = (await readState(env, "last_alerted_report_pk")) ?? 0;
  const lastStaleAlertAt = await readState(env, "last_stale_alert_at");

  const records = await env.DMARC_DB.prepare(
    `SELECT r.id AS reportPk, r.org_name AS orgName, r.domain AS domain,
            r.date_begin AS windowBegin, a.source_ip AS sourceIp, a.msg_count AS msgCount,
            a.disposition AS disposition, a.dkim_evaluated AS dkimEvaluated,
            a.spf_evaluated AS spfEvaluated, a.header_from AS headerFrom
       FROM aggregate_record a
       JOIN aggregate_report r ON r.id = a.report_pk
      WHERE r.id > ?
      ORDER BY r.id`,
  )
    .bind(cursor)
    .all<EvaluatedRecord>();

  const bounds = await env.DMARC_DB.prepare(
    `SELECT MAX(date_end) AS latestWindowEnd, COALESCE(MAX(id), 0) AS maxReportPk
       FROM aggregate_report`,
  ).first<{ latestWindowEnd: number | null; maxReportPk: number }>();

  // Per migration 0002 this shape means exactly one thing: parsed, then lost.
  //
  // status='rejected' is DELIBERATELY NOT counted. reports@wbhk.my is a public mailbox, so rejects
  // include ordinary unsolicited mail; alerting on them would make the channel noisy for a condition
  // that is usually not ours. Real ingestion breakage shows up in the query below regardless.
  const broken = await env.DMARC_DB.prepare(
    `SELECT COUNT(*) AS n FROM inbound_message
      WHERE status = 'parsed' AND is_duplicate = 0
        AND id NOT IN (SELECT message_id FROM aggregate_report)`,
  ).first<{ n: number }>();

  return {
    records: records.results ?? [],
    latestWindowEnd: bounds?.latestWindowEnd ?? null,
    brokenIngestions: broken?.n ?? 0,
    maxReportPk: bounds?.maxReportPk ?? 0,
    cursor,
    lastStaleAlertAt,
  };
}

export default {
  /**
   * The daily health check (see alert.ts for WHY it watches three things and not just failures).
   *
   * ORDERING IS LOAD-BEARING: state advances only AFTER a successful send. If Resend is down, the cursor
   * stays put and the next run re-evaluates the same records rather than skipping them silently.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const snapshot = await readSnapshot(env);
    const now = Math.floor(Date.now() / 1000);

    const findings = evaluateHealth(
      {
        now,
        records: snapshot.records,
        latestWindowEnd: snapshot.latestWindowEnd,
        brokenIngestions: snapshot.brokenIngestions,
        lastStaleAlertAt: snapshot.lastStaleAlertAt,
      },
      DEFAULT_ALERT_CONFIG,
    );

    if (findings.length === 0) {
      // Still advance past the records we just cleared, so a healthy report is never re-examined.
      if (snapshot.maxReportPk > snapshot.cursor) {
        await writeState(env, "last_alerted_report_pk", snapshot.maxReportPk);
      }
      return;
    }

    const { subject, text } = formatAlert(findings, now);
    if (env.EMAIL_MODE === "log") {
      // The explicit opt-out, not a fallback: without it a missing key is a hard preflight failure.
      // Printing keeps the rest of the cron path exercisable — parse, diff, state-write — for someone
      // who cannot hold a Resend credential.
      console.log(`[dmarc] EMAIL_MODE=log — alert NOT sent\n${subject}\n${text}`);
      return;
    }
    await sendAlert(
      { apiKey: env.RESEND_API_KEY, from: ALERT_FROM, to: env.ALERT_TO },
      subject,
      text,
      (url, init) => fetch(url, init),
    );

    if (snapshot.maxReportPk > snapshot.cursor) {
      await writeState(env, "last_alerted_report_pk", snapshot.maxReportPk);
    }
    if (findings.some((f) => f.kind === "stale")) {
      await writeState(env, "last_stale_alert_at", now);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // The forwarded copy's Authentication-Results IS the section 3 evidence: it records whether the
    // iCloud -> Cloudflare hop kept SPF or DKIM alive. Capture it whatever else happens.
    const authResults = message.headers.get("authentication-results");
    const rcptTo = message.to;
    const mailFrom = message.from;

    let raw: Uint8Array;
    try {
      raw = await readRaw(message);
    } catch (cause) {
      await recordMessage(env, {
        mailFrom,
        rcptTo,
        subject: null,
        authResults,
        attachments: "[]",
        rawBytes: -1,
        status: "rejected",
        error: `unreadable: ${(cause as Error).message}`,
      });
      return;
    }

    let subject: string | null = null;
    // No initialisers: the catch below returns, so a default here would be dead (eslint no-useless-assignment).
    let candidates: CandidateAttachment[];
    let attachmentSummary: string;

    try {
      const mail = await PostalMime.parse(raw);
      subject = mail.subject ?? null;
      candidates = (mail.attachments ?? []).map((a) => ({
        filename: a.filename ?? undefined,
        mimeType: a.mimeType ?? undefined,
        content:
          typeof a.content === "string"
            ? new TextEncoder().encode(a.content)
            : new Uint8Array(a.content as ArrayBuffer),
      }));
      attachmentSummary = JSON.stringify(
        candidates.map((c) => ({
          name: c.filename,
          type: c.mimeType,
          bytes: c.content.byteLength,
        })),
      );
    } catch (cause) {
      await recordMessage(env, {
        mailFrom,
        rcptTo,
        subject,
        authResults,
        attachments: "[]",
        rawBytes: raw.byteLength,
        status: "rejected",
        error: `mime parse failed: ${(cause as Error).message}`,
      });
      return;
    }

    const picked = selectReportAttachment(candidates);
    if (!picked) {
      // A real, distinct outcome: something arrived carrying no report. Recorded, not silently dropped —
      // this row is also what proves the hop works even when the payload is not a report.
      await recordMessage(env, {
        mailFrom,
        rcptTo,
        subject,
        authResults,
        attachments: attachmentSummary,
        rawBytes: raw.byteLength,
        status: "rejected",
        error: "no report-shaped attachment",
      });
      return;
    }

    let report;
    try {
      const xml = await decompressReport(picked.content, picked.filename ?? "");
      report = parseAggregateReport(xml);
    } catch (cause) {
      await recordMessage(env, {
        mailFrom,
        rcptTo,
        subject,
        authResults,
        attachments: attachmentSummary,
        rawBytes: raw.byteLength,
        status: "rejected",
        error: `${(cause as Error).name}: ${(cause as Error).message}`,
      });
      return;
    }

    const messageId = await recordMessage(env, {
      mailFrom,
      rcptTo,
      subject,
      authResults,
      attachments: attachmentSummary,
      rawBytes: raw.byteLength,
      status: "parsed",
      error: null,
    });

    // ON CONFLICT DO NOTHING + RETURNING yields no row on a duplicate, so a redelivered report is a no-op
    // rather than a double-count. A forward can be retried; a reporter can resend.
    const inserted = await env.DMARC_DB.prepare(
      `INSERT INTO aggregate_report
         (message_id, org_name, report_id, domain, date_begin, date_end, policy_p, policy_sp, policy_np, adkim, aspf)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_name, report_id, domain) DO NOTHING
       RETURNING id`,
    )
      .bind(
        messageId,
        report.orgName,
        report.reportId,
        report.domain,
        report.dateRangeBegin,
        report.dateRangeEnd,
        report.policyPublished.p,
        report.policyPublished.sp ?? null,
        report.policyPublished.np ?? null,
        report.policyPublished.adkim ?? null,
        report.policyPublished.aspf ?? null,
      )
      .first<{ id: number }>();

    if (!inserted) {
      // Already ingested. Mark the row we already wrote rather than leaving it 'parsed' with no linked
      // report — that shape is indistinguishable from "parsed, but the write failed and we lost it",
      // precisely the ambiguity this pipeline exists to eliminate. The UPDATE comes AFTER the insert on
      // purpose: record-before-understanding survives, we only sharpen the verdict.
      await env.DMARC_DB.prepare(`UPDATE inbound_message SET is_duplicate = 1 WHERE id = ?`)
        .bind(messageId)
        .run();
      return;
    }

    const stmt = env.DMARC_DB.prepare(
      `INSERT INTO aggregate_record
         (report_pk, source_ip, msg_count, disposition, dkim_evaluated, spf_evaluated, header_from, dkim_auth, spf_auth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DMARC_DB.batch(
      report.records.map((r) =>
        stmt.bind(
          inserted.id,
          r.sourceIp,
          r.count,
          r.disposition,
          r.dkimEvaluated,
          r.spfEvaluated,
          r.headerFrom,
          JSON.stringify(r.dkimAuth),
          JSON.stringify(r.spfAuth),
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
