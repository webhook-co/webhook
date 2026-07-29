import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";

// The scheduled health check against a REAL D1 in workerd.
//
// alert.test.ts proves the PREDICATES; this proves the WIRING, and the wiring is where this feature can
// fail invisibly. A monitor that queries the wrong column, or advances its cursor past an alert it never
// managed to send, reports perfect health forever — indistinguishable from a system that is actually
// fine. Those are exactly the cases below, and each one is run against the same migrations the deploy
// applies, so a schema mistake fails here rather than at 09:00 UTC in production.

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DMARC_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    RESEND_API_KEY: string;
    ALERT_TO: string;
  }
}

const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Insert a report plus one record, bypassing the email path — this suite is about the cron, not ingest. */
async function seedReport(opts: {
  reportId: string;
  windowEnd: number;
  disposition?: string;
  dkim?: string;
  spf?: string;
  count?: number;
}): Promise<number> {
  // aggregate_report.message_id is NOT NULL and FK-references inbound_message, so a report cannot exist
  // without the message it arrived in. Seed the parent rather than working around the constraint — this
  // row is also what keeps the fixture out of the "parsed but never stored" count.
  const m = await env.DMARC_DB.prepare(
    `INSERT INTO inbound_message
       (received_at, mail_from, rcpt_to, subject, auth_results, attachments, raw_bytes, status, error, is_duplicate)
     VALUES ('2026-07-29T00:00:00Z', 'dmarc@webhook.co', 'reports@wbhk.my', ?, NULL, '[]', 100, 'parsed', NULL, 0)
     RETURNING id`,
  )
    .bind(`report ${opts.reportId}`)
    .first<{ id: number }>();

  const r = await env.DMARC_DB.prepare(
    `INSERT INTO aggregate_report
       (message_id, org_name, report_id, domain, date_begin, date_end, policy_p, policy_sp, policy_np, adkim, aspf)
     VALUES (?, 'google.com', ?, 'webhook.co', ?, ?, 'reject', 'reject', 'reject', 'r', 'r')
     RETURNING id`,
  )
    .bind(m!.id, opts.reportId, opts.windowEnd - DAY + 1, opts.windowEnd)
    .first<{ id: number }>();

  await env.DMARC_DB.prepare(
    `INSERT INTO aggregate_record
       (report_pk, source_ip, msg_count, disposition, dkim_evaluated, spf_evaluated, header_from, dkim_auth, spf_auth)
     VALUES (?, '203.0.113.9', ?, ?, ?, ?, 'webhook.co', '[]', '[]')`,
  )
    .bind(
      r!.id,
      opts.count ?? 1,
      opts.disposition ?? "none",
      opts.dkim ?? "pass",
      opts.spf ?? "pass",
    )
    .run();

  return r!.id;
}

async function state(key: string): Promise<string | null> {
  const row = await env.DMARC_DB.prepare(`SELECT value FROM alert_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

interface SentAlert {
  subject: string;
  text: string;
  to: string[];
  from: string;
}

/** Stub global fetch and capture what the Worker tried to send. */
function captureSends(status = 200): SentAlert[] {
  const sent: SentAlert[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    expect(url).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(init.body) as SentAlert);
    return new Response("{}", { status });
  });
  return sent;
}

const runCron = () => worker.scheduled({} as ScheduledController, env as never);

beforeEach(async () => {
  await applyD1Migrations(env.DMARC_DB, env.TEST_MIGRATIONS);
  await env.DMARC_DB.prepare(`DELETE FROM aggregate_record`).run();
  await env.DMARC_DB.prepare(`DELETE FROM aggregate_report`).run();
  await env.DMARC_DB.prepare(`DELETE FROM inbound_message`).run();
  await env.DMARC_DB.prepare(`DELETE FROM alert_state`).run();
  await env.DMARC_DB.prepare(
    `INSERT INTO alert_state (key, value) VALUES ('last_alerted_report_pk', '0')`,
  ).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduled health check", () => {
  it("stays silent and advances the cursor when a fresh report is clean", async () => {
    const sent = captureSends();
    const pk = await seedReport({ reportId: "clean-1", windowEnd: nowSec() - DAY });

    await runCron();

    expect(sent).toHaveLength(0);
    expect(await state("last_alerted_report_pk")).toBe(String(pk));
  });

  it("sends one alert naming the failing source when a record fails DMARC", async () => {
    const sent = captureSends();
    await seedReport({
      reportId: "bad-1",
      windowEnd: nowSec() - DAY,
      disposition: "reject",
      dkim: "fail",
      spf: "fail",
      count: 5,
    });

    await runCron();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("webhook.co");
    expect(sent[0].subject).toContain("5");
    expect(sent[0].text).toContain("203.0.113.9");
    expect(sent[0].to).toEqual(["alerts@example.test"]);
    expect(sent[0].from).toBe("dmarc-alerts@mail.webhook.co");
  });

  // The forwarding shape, end to end. This is the one false positive that would make the channel
  // untrustworthy, and it has already occurred in production (2026-07-17, a Gmail forwarding relay).
  it("stays silent on spf=fail with dkim=pass, through the real query path", async () => {
    const sent = captureSends();
    await seedReport({ reportId: "fwd-1", windowEnd: nowSec() - DAY, spf: "fail" });

    await runCron();

    expect(sent).toHaveLength(0);
  });

  it("does not re-alert on the same report on a subsequent run", async () => {
    const sent = captureSends();
    await seedReport({
      reportId: "bad-2",
      windowEnd: nowSec() - DAY,
      disposition: "reject",
    });

    await runCron();
    await runCron();

    expect(sent).toHaveLength(1);
  });

  // THE CRITICAL ONE. If the cursor advanced despite a failed send, those records would be permanently
  // skipped: the next run starts above them, finds nothing, and reports health — a real DMARC failure
  // silently swallowed by a transient Resend outage.
  it("leaves the cursor untouched when the send fails, so the alert is retried", async () => {
    captureSends(500);
    await seedReport({ reportId: "bad-3", windowEnd: nowSec() - DAY, disposition: "reject" });

    await expect(runCron()).rejects.toThrow(/500/);
    expect(await state("last_alerted_report_pk")).toBe("0");

    // Next run, with the channel healthy again, must still find and report it.
    const sent = captureSends();
    await runCron();
    expect(sent).toHaveLength(1);
  });

  it("alerts on a stale feed even though every stored record passed", async () => {
    const sent = captureSends();
    await seedReport({ reportId: "old-1", windowEnd: nowSec() - 30 * DAY });

    await runCron();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/stale|no report/i);
    expect(await state("last_stale_alert_at")).not.toBeNull();
  });

  // An empty database is the alarming end of the scale, not the quiet one: it means the pipeline has
  // never once worked. Scoring "no rows" as healthy is precisely how a dead feed hides.
  it("treats an empty database as stale rather than healthy", async () => {
    const sent = captureSends();

    await runCron();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/stale|no report/i);
  });

  it("does not repeat the staleness alert on the next day's run", async () => {
    const sent = captureSends();
    await seedReport({ reportId: "old-2", windowEnd: nowSec() - 30 * DAY });

    await runCron();
    await runCron();

    expect(sent).toHaveLength(1);
  });

  // Per migration 0002: parsed, not a duplicate, and linking to no report means the report was understood
  // and then lost. No DMARC-outcome query can see this, because the rows it would read are the missing ones.
  it("alerts when a message parsed but was never stored", async () => {
    const sent = captureSends();
    await seedReport({ reportId: "fine-1", windowEnd: nowSec() - DAY });
    await env.DMARC_DB.prepare(
      `INSERT INTO inbound_message
         (received_at, mail_from, rcpt_to, subject, auth_results, attachments, raw_bytes, status, error, is_duplicate)
       VALUES ('2026-07-29T00:00:00Z', 'a@b.c', 'reports@wbhk.my', 's', NULL, '[]', 10, 'parsed', NULL, 0)`,
    ).run();

    await runCron();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/never stored/i);
  });

  // The mailbox is public, so unsolicited mail lands as status='rejected' routinely. Alerting on it would
  // make the channel noisy for a condition that is usually not ours at all.
  it("ignores rejected inbound messages, which are ordinary for a public mailbox", async () => {
    const sent = captureSends();
    await seedReport({ reportId: "fine-2", windowEnd: nowSec() - DAY });
    await env.DMARC_DB.prepare(
      `INSERT INTO inbound_message
         (received_at, mail_from, rcpt_to, subject, auth_results, attachments, raw_bytes, status, error, is_duplicate)
       VALUES ('2026-07-29T00:00:00Z', 'spam@x.y', 'reports@wbhk.my', 's', NULL, '[]', 10, 'rejected', 'no report-shaped attachment', 0)`,
    ).run();

    await runCron();

    expect(sent).toHaveLength(0);
  });

  it("reports failures and staleness together rather than only the first", async () => {
    const sent = captureSends();
    await seedReport({
      reportId: "bad-old",
      windowEnd: nowSec() - 30 * DAY,
      disposition: "reject",
    });

    await runCron();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/DMARC FAILURES/);
    expect(sent[0].text).toMatch(/NO REPORTS FOR/);
  });
});
