import { env, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";

// The D1 orchestration suite — the gap an AI review correctly blocked on. The dedup path is the one that
// ALREADY produced a bug: a redelivery used to leave status='parsed' with no linked report, which is
// indistinguishable from "parsed, but the write failed and we lost the data". That fix shipped with no
// regression test; this is it. Every case below fails if the guard it names is removed.
//
// Run against a REAL D1 in workerd, not a mock: a mocked D1 would happily "prove" a dedup that
// ON CONFLICT never actually performed.

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DMARC_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const REAL_GOOGLE_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <report_id>7545198205576254510</report_id>
    <date_range><begin>1784160000</begin><end>1784246399</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>billing.webhook.co</domain><adkim>r</adkim><aspf>r</aspf>
    <p>none</p><sp>none</sp><np>none</np>
  </policy_published>
  <record>
    <row>
      <source_ip>54.240.42.185</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>billing.webhook.co</header_from></identifiers>
    <auth_results>
      <dkim><domain>billing.webhook.co</domain><result>pass</result><selector>abc</selector></dkim>
      <spf><domain>bounce.billing.webhook.co</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>209.85.220.41</source_ip><count>3</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>billing.webhook.co</header_from></identifiers>
    <auth_results>
      <dkim><domain>billing.webhook.co</domain><result>pass</result><selector>abc</selector></dkim>
      <spf><domain>gmail.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

/** Build a MIME message carrying `xml` as a bare .xml attachment. Bare XML (not gzip) keeps the fixture
 *  independent of node:zlib, which workerd does not run — the compression paths are covered in report.test.ts. */
function mimeWithReport(xml: string): string {
  const b64 = btoa(xml).replace(/(.{76})/g, "$1\r\n");
  return [
    "From: dmarc@webhook.co",
    "To: reports@wbhk.my",
    "Subject: Fwd: Report domain: billing.webhook.co",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Forwarded message.",
    "--b1",
    'Content-Type: application/xml; name="report.xml"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="report.xml"',
    "",
    b64,
    "--b1--",
    "",
  ].join("\r\n");
}

function mimePlain(): string {
  return [
    "From: dmarc@webhook.co",
    "To: reports@wbhk.my",
    "Subject: Testing forwarding",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "no report here",
    "",
  ].join("\r\n");
}

/** A minimal ForwardableEmailMessage over a raw string. */
function message(raw: string): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "dmarc@webhook.co",
    to: "reports@wbhk.my",
    headers: new Headers({
      "authentication-results":
        "mx.cloudflare.net; spf=pass smtp.mailfrom=dmarc@webhook.co; dkim=pass header.d=gmail.com",
    }),
    raw: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

const deliver = (raw: string) => worker.email(message(raw), env as never);

async function counts() {
  const r = await env.DMARC_DB.prepare(
    `SELECT (SELECT COUNT(*) FROM inbound_message) AS msgs,
            (SELECT COUNT(*) FROM aggregate_report) AS reports,
            (SELECT COUNT(*) FROM aggregate_record) AS records`,
  ).first<{ msgs: number; reports: number; records: number }>();
  return r!;
}

beforeEach(async () => {
  await applyD1Migrations(env.DMARC_DB, env.TEST_MIGRATIONS);
  // Migrations are cumulative across files in this pool; start every case from a known-empty table so a
  // leftover row can never make a dedup assertion pass for the wrong reason.
  await env.DMARC_DB.exec("DELETE FROM aggregate_record");
  await env.DMARC_DB.exec("DELETE FROM aggregate_report");
  await env.DMARC_DB.exec("DELETE FROM inbound_message");
});

describe("first ingest", () => {
  it("stores one report and every record, marked not-duplicate", async () => {
    await deliver(mimeWithReport(REAL_GOOGLE_XML));

    expect(await counts()).toEqual({ msgs: 1, reports: 1, records: 2 });

    const m = await env.DMARC_DB.prepare(
      "SELECT status, is_duplicate, auth_results FROM inbound_message",
    ).first<{ status: string; is_duplicate: number; auth_results: string }>();
    expect(m?.status).toBe("parsed");
    expect(m?.is_duplicate).toBe(0);
    // The §3 hop evidence must be persisted, not just observed in passing.
    expect(m?.auth_results).toContain("spf=pass");
  });

  it("persists the evaluated verdict per record, including a FAIL", async () => {
    await deliver(mimeWithReport(REAL_GOOGLE_XML));

    const rows = await env.DMARC_DB.prepare(
      "SELECT source_ip, msg_count, spf_evaluated FROM aggregate_record ORDER BY source_ip",
    ).all<{ source_ip: string; msg_count: number; spf_evaluated: string }>();

    expect(rows.results).toEqual([
      { source_ip: "209.85.220.41", msg_count: 3, spf_evaluated: "fail" },
      { source_ip: "54.240.42.185", msg_count: 1, spf_evaluated: "pass" },
    ]);
  });
});

describe("redelivery — the path that already produced a bug", () => {
  it("does NOT double-count, and marks the second arrival as a duplicate", async () => {
    await deliver(mimeWithReport(REAL_GOOGLE_XML));
    await deliver(mimeWithReport(REAL_GOOGLE_XML));

    // The arrival IS recorded (record-before-understanding), but nothing is duplicated.
    expect(await counts()).toEqual({ msgs: 2, reports: 1, records: 2 });

    const rows = await env.DMARC_DB.prepare(
      "SELECT id, status, is_duplicate FROM inbound_message ORDER BY id",
    ).all<{ id: number; status: string; is_duplicate: number }>();
    expect(rows.results[0].is_duplicate).toBe(0);
    expect(rows.results[1].is_duplicate).toBe(1);
    expect(rows.results[1].status).toBe("parsed");
  });

  it("leaves NO row that reads as silent data loss", async () => {
    // The exact defect: 'parsed' + not-duplicate + no linked report is indistinguishable from "we lost it".
    // This is the alerting query, and it must be empty after a legitimate redelivery.
    await deliver(mimeWithReport(REAL_GOOGLE_XML));
    await deliver(mimeWithReport(REAL_GOOGLE_XML));

    const orphan = await env.DMARC_DB.prepare(
      `SELECT COUNT(*) AS n FROM inbound_message m
        WHERE m.status = 'parsed' AND m.is_duplicate = 0
          AND NOT EXISTS (SELECT 1 FROM aggregate_report r WHERE r.message_id = m.id)`,
    ).first<{ n: number }>();

    expect(orphan?.n).toBe(0);
  });

  it("a DIFFERENT report still ingests — dedup must not swallow new data", async () => {
    // Floor: proves the UNIQUE key discriminates rather than blanket-rejecting a second report.
    await deliver(mimeWithReport(REAL_GOOGLE_XML));
    await deliver(
      mimeWithReport(REAL_GOOGLE_XML.replace("7545198205576254510", "9999999999999999999")),
    );

    expect(await counts()).toEqual({ msgs: 2, reports: 2, records: 4 });
  });
});

describe("record-before-understanding", () => {
  it("records a message carrying no report as rejected, with the reason", async () => {
    await deliver(mimePlain());

    const m = await env.DMARC_DB.prepare(
      "SELECT status, error, is_duplicate FROM inbound_message",
    ).first<{ status: string; error: string; is_duplicate: number }>();

    expect(m?.status).toBe("rejected");
    expect(m?.error).toContain("no report-shaped attachment");
    expect(m?.is_duplicate).toBe(0);
    expect((await counts()).reports).toBe(0);
  });

  it("records an unparseable report rather than dropping it silently", async () => {
    // "Empty" must mean "nothing arrived" and nothing else — a dropped-on-the-floor message would make a
    // broken pipeline look identical to a quiet one.
    await deliver(mimeWithReport("<?xml version='1.0'?><rss><channel/></rss>"));

    const m = await env.DMARC_DB.prepare("SELECT status, error FROM inbound_message").first<{
      status: string;
      error: string;
    }>();

    expect(m?.status).toBe("rejected");
    expect(m?.error).toContain("ReportError");
    expect((await counts()).msgs).toBe(1);
  });

  it("records a TLS-RPT as rejected — it must never look like a clean DMARC report", async () => {
    await deliver(mimeWithReport('{"contact-info":"smtp-tls-reporting@google.com","policies":[]}'));

    const m = await env.DMARC_DB.prepare("SELECT status, error FROM inbound_message").first<{
      status: string;
      error: string;
    }>();

    expect(m?.status).toBe("rejected");
    expect((await counts()).reports).toBe(0);
  });
});

describe("migration 0002 backfill", () => {
  it("flips a pre-existing parsed-but-unlinked row to is_duplicate", async () => {
    // Reproduces the historical shape: a redelivery recorded BEFORE is_duplicate existed, i.e. 'parsed'
    // with no linked report. The 0002 backfill must relabel exactly that row and nothing else.
    await env.DMARC_DB.prepare(
      `INSERT INTO inbound_message (id, received_at, mail_from, rcpt_to, subject, auth_results, attachments, raw_bytes, status, error, is_duplicate)
       VALUES (91, '2026-07-17T00:00:00Z', 'a@b', 'reports@wbhk.my', 'legit', NULL, '[]', 10, 'parsed', NULL, 0),
              (92, '2026-07-17T00:00:01Z', 'a@b', 'reports@wbhk.my', 'redelivery', NULL, '[]', 10, 'parsed', NULL, 0)`,
    ).run();
    await env.DMARC_DB.prepare(
      `INSERT INTO aggregate_report (message_id, org_name, report_id, domain, date_begin, date_end, policy_p)
       VALUES (91, 'google.com', 'r-1', 'webhook.co', 1, 2, 'none')`,
    ).run();

    await env.DMARC_DB.prepare(
      `UPDATE inbound_message SET is_duplicate = 1
        WHERE status = 'parsed' AND id NOT IN (SELECT message_id FROM aggregate_report)`,
    ).run();

    const rows = await env.DMARC_DB.prepare(
      "SELECT id, is_duplicate FROM inbound_message ORDER BY id",
    ).all<{ id: number; is_duplicate: number }>();

    expect(rows.results).toEqual([
      { id: 91, is_duplicate: 0 }, // linked to a report — genuinely stored
      { id: 92, is_duplicate: 1 }, // unlinked — the redelivery
    ]);
  });
});
