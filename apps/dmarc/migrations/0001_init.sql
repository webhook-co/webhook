-- Every inbound message is recorded BEFORE we try to understand it. That is the point: a hop that
-- silently drops mail and a hop that delivers something we cannot parse look identical from the outside,
-- and "no rows" must never be ambiguous between "nothing arrived" and "everything was rejected".
CREATE TABLE IF NOT EXISTS inbound_message (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    TEXT    NOT NULL,
  mail_from      TEXT    NOT NULL,
  rcpt_to        TEXT    NOT NULL,
  subject        TEXT,
  -- The forwarded copy's Authentication-Results. This is the runbook section 3 evidence: it records
  -- whether the iCloud -> Cloudflare hop kept SPF or DKIM alive.
  auth_results   TEXT,
  attachments    TEXT,
  raw_bytes      INTEGER NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('parsed', 'rejected')), -- superseded by 0002: adds 'duplicate'
  error          TEXT
);

CREATE TABLE IF NOT EXISTS aggregate_report (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES inbound_message(id),
  org_name     TEXT    NOT NULL,
  report_id    TEXT    NOT NULL,
  domain       TEXT    NOT NULL,
  date_begin   INTEGER NOT NULL,
  date_end     INTEGER NOT NULL,
  policy_p     TEXT    NOT NULL,
  policy_sp    TEXT,
  policy_np    TEXT,
  adkim        TEXT,
  aspf         TEXT,
  -- Idempotency: a forward can be retried and a reporter can resend. Without this, a redelivery would
  -- silently double-count and make a clean window look busier than it was.
  UNIQUE (org_name, report_id, domain)
);

CREATE TABLE IF NOT EXISTS aggregate_record (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_pk      INTEGER NOT NULL REFERENCES aggregate_report(id),
  source_ip      TEXT    NOT NULL,
  msg_count      INTEGER NOT NULL,
  disposition    TEXT    NOT NULL,
  dkim_evaluated TEXT    NOT NULL,
  spf_evaluated  TEXT    NOT NULL,
  header_from    TEXT    NOT NULL,
  dkim_auth      TEXT    NOT NULL,
  spf_auth       TEXT    NOT NULL
);

-- The query this exists to answer: "did anything fail DMARC, and who sent it?"
CREATE INDEX IF NOT EXISTS aggregate_record_failures
  ON aggregate_record (dkim_evaluated, spf_evaluated);
CREATE INDEX IF NOT EXISTS aggregate_report_domain_window
  ON aggregate_report (domain, date_begin);
