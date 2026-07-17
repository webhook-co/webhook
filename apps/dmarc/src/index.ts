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

import { selectReportAttachment, type CandidateAttachment } from "./ingest.js";
import { decompressReport, parseAggregateReport, ReportError } from "./report.js";

export interface Env {
  DMARC_DB: D1Database;
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

export default {
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
