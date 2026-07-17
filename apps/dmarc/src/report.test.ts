import { describe, expect, it } from "vitest";
import { gzipSync, deflateRawSync } from "node:zlib";

import { decompressReport, parseAggregateReport, ReportError } from "./report.js";

// The fixture is a REAL Google aggregate for billing.webhook.co (report_id 7545198205576254510, window
// 2026-07-16). Kept verbatim rather than hand-written: the whole point of this parser is to survive what
// reporters actually emit, and a fixture we invented would only ever prove we can parse ourselves.
// Note it carries TWO dkim blocks — Stripe rides Amazon SES, so every record has a second
// `d=amazonses.com` signature that is NOT ours and must not be mistaken for an unknown sender.
const REAL_GOOGLE_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <version>1.0</version>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>7545198205576254510</report_id>
    <date_range>
      <begin>1784160000</begin>
      <end>1784246399</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>billing.webhook.co</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
    <np>none</np>
  </policy_published>
  <record>
    <row>
      <source_ip>54.240.42.185</source_ip>
      <count>1</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>billing.webhook.co</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>billing.webhook.co</domain>
        <result>pass</result>
        <selector>fhpy7csz2sxi2676ep2d2vioiehxwj2f</selector>
      </dkim>
      <dkim>
        <domain>amazonses.com</domain>
        <result>pass</result>
        <selector>224i4yxa5dv7c2xz3womw6peuasteono</selector>
      </dkim>
      <spf>
        <domain>bounce.billing.webhook.co</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

/** Build a minimal single-entry ZIP (local header + raw-deflate payload + central directory + EOCD). */
function makeZip(name: string, contents: string): Uint8Array {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents, "utf8");
  const deflated = deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const localOffset = 0;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(localOffset, 42);

  const centralStart = local.length + nameBytes.length + deflated.length;
  const centralSize = central.length + nameBytes.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd]));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

describe("parseAggregateReport", () => {
  it("parses a real Google aggregate into its metadata, policy and records", () => {
    const r = parseAggregateReport(REAL_GOOGLE_XML);

    expect(r.orgName).toBe("google.com");
    expect(r.reportId).toBe("7545198205576254510");
    expect(r.domain).toBe("billing.webhook.co");
    expect(r.dateRangeBegin).toBe(1784160000);
    expect(r.dateRangeEnd).toBe(1784246399);
    expect(r.policyPublished).toEqual({ p: "none", sp: "none", np: "none", adkim: "r", aspf: "r" });
    expect(r.records).toHaveLength(1);
  });

  it("extracts the evaluated verdict, which is what actually gates the ramp", () => {
    const [rec] = parseAggregateReport(REAL_GOOGLE_XML).records;

    expect(rec.sourceIp).toBe("54.240.42.185");
    expect(rec.count).toBe(1);
    expect(rec.disposition).toBe("none");
    expect(rec.dkimEvaluated).toBe("pass");
    expect(rec.spfEvaluated).toBe("pass");
    expect(rec.headerFrom).toBe("billing.webhook.co");
  });

  it("keeps EVERY dkim auth_result, not just the first", () => {
    // Regression guard: Resend and Stripe both ride Amazon SES, so a second d=amazonses.com signature is
    // normal. Collapsing auth_results to one entry would make that second signature look like a missing
    // record — or worse, make a genuinely unknown signer invisible.
    const [rec] = parseAggregateReport(REAL_GOOGLE_XML).records;

    expect(rec.dkimAuth).toEqual([
      {
        domain: "billing.webhook.co",
        result: "pass",
        selector: "fhpy7csz2sxi2676ep2d2vioiehxwj2f",
      },
      { domain: "amazonses.com", result: "pass", selector: "224i4yxa5dv7c2xz3womw6peuasteono" },
    ]);
    expect(rec.spfAuth).toEqual([{ domain: "bounce.billing.webhook.co", result: "pass" }]);
  });

  it("reports a FAIL verdict as a fail (the case the whole pipeline exists to surface)", () => {
    const failing = REAL_GOOGLE_XML.replace(
      "<dkim>pass</dkim>\n        <spf>pass</spf>",
      "<dkim>fail</dkim>\n        <spf>fail</spf>",
    ).replace("<disposition>none</disposition>", "<disposition>reject</disposition>");

    const [rec] = parseAggregateReport(failing).records;

    expect(rec.dkimEvaluated).toBe("fail");
    expect(rec.spfEvaluated).toBe("fail");
    expect(rec.disposition).toBe("reject");
  });

  it("parses a multi-record report (a mid-window ramp splits reports, it does not merge records)", () => {
    const two = REAL_GOOGLE_XML.replace(
      "</feedback>",
      `<record>
    <row>
      <source_ip>209.85.220.41</source_ip>
      <count>3</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>billing.webhook.co</header_from></identifiers>
    <auth_results>
      <dkim><domain>billing.webhook.co</domain><result>pass</result><selector>x</selector></dkim>
      <spf><domain>gmail.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`,
    );

    const r = parseAggregateReport(two);

    expect(r.records).toHaveLength(2);
    expect(r.records[1].sourceIp).toBe("209.85.220.41");
    expect(r.records[1].count).toBe(3);
    expect(r.records[1].spfEvaluated).toBe("fail");
  });

  it("rejects a TLS-RPT report BY SHAPE — same mailbox, same .gz, different protocol", () => {
    // These arrive at the same catch-all and are trivially confusable. A TLS-RPT silently parsed as an
    // empty DMARC report is the worst case: it looks like clean data.
    // Asserting the MESSAGE, not just the type: a bare toThrow(ReportError) passes even with the JSON
    // check deleted, because the XML parser happens to choke on JSON anyway — which pins nothing.
    // (Verified by mutation: deleting the guard survived a type-only assertion.)
    const tlsrpt = JSON.stringify({
      "organization-name": "Google Inc.",
      "contact-info": "smtp-tls-reporting@google.com",
      "report-id": "2026-07-15T00:00:00Z_webhook.co",
      policies: [{ policy: { "policy-type": "no-policy-found" } }],
    });

    expect(() => parseAggregateReport(tlsrpt)).toThrow(/TLS-RPT/);
  });

  it("rejects XML that is well-formed but is not a DMARC feedback document", () => {
    expect(() => parseAggregateReport("<?xml version='1.0'?><rss><channel/></rss>")).toThrow(
      ReportError,
    );
  });

  it("rejects a feedback document with no records rather than inventing an empty pass", () => {
    const empty = REAL_GOOGLE_XML.replace(/<record>[\s\S]*<\/record>/, "");
    expect(() => parseAggregateReport(empty)).toThrow(ReportError);
  });

  it("rejects malformed input instead of returning a half-parsed report", () => {
    expect(() => parseAggregateReport("not xml at all")).toThrow(ReportError);
    expect(() => parseAggregateReport("")).toThrow(ReportError);
  });

  it("refuses a DOCTYPE even on an OTHERWISE-VALID report (XXE) — the mailbox is effectively open", () => {
    // The fixture is the real report, complete and parseable, with ONLY a DOCTYPE prepended. That matters:
    // an earlier version of this test used a stub document missing policy_published, so it threw for a
    // totally unrelated reason and passed with the XXE guard deleted. Verified by mutation: with this
    // fixture, removing the DOCTYPE refusal makes the report parse cleanly and this test fail.
    const xxe = REAL_GOOGLE_XML.replace(
      '<?xml version="1.0" encoding="UTF-8" ?>',
      '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE feedback [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    );

    // Sanity floor: without the DOCTYPE this fixture MUST parse, or the test proves nothing.
    expect(parseAggregateReport(REAL_GOOGLE_XML).orgName).toBe("google.com");

    expect(() => parseAggregateReport(xxe)).toThrow(/DOCTYPE/);
  });
});

describe("decompressReport", () => {
  it("gunzips a .gz report", async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(REAL_GOOGLE_XML, "utf8")));

    await expect(decompressReport(gz, "report.xml.gz")).resolves.toContain(
      "<org_name>google.com</org_name>",
    );
  });

  it("unzips a .zip report — DecompressionStream cannot do zip, so this is hand-rolled", async () => {
    // Google sends .zip (every fixture in this lane arrived as one) and Microsoft/Yahoo do too. Treating
    // zip as gzip fails at the header and would silently drop the majority of real reports.
    const zip = makeZip("google.com!webhook.co!1784160000!1784246399.xml", REAL_GOOGLE_XML);

    await expect(decompressReport(zip, "r.zip")).resolves.toContain(
      "<report_id>7545198205576254510</report_id>",
    );
  });

  it("passes through uncompressed XML", async () => {
    const raw = new TextEncoder().encode(REAL_GOOGLE_XML);

    await expect(decompressReport(raw, "report.xml")).resolves.toContain("<feedback>");
  });

  it("detects the container from MAGIC BYTES, not the filename", async () => {
    // Filenames are attacker/reporter-controlled and inconsistent across reporters. Sniffing content is the
    // only thing that holds when a reporter mislabels an attachment.
    const gz = new Uint8Array(gzipSync(Buffer.from(REAL_GOOGLE_XML, "utf8")));

    await expect(decompressReport(gz, "totally-lying-name.xml")).resolves.toContain("<feedback>");
  });

  it("refuses an oversized payload BEFORE decompressing it", async () => {
    // Asserting the MESSAGE, not just the type. A bare toThrow(ReportError) passes with the cap deleted,
    // because 11MB of zeros is not valid gzip and blows up in the inflater anyway — so it would prove the
    // inflater rejects garbage, not that we refuse oversized input. (Verified by mutation.)
    const huge = new Uint8Array(11 * 1024 * 1024);
    huge.set([0x1f, 0x8b]);

    await expect(decompressReport(huge, "big.gz")).rejects.toThrow(/exceeds cap/);
  });

  it("accepts a payload just UNDER the cap (floor: proves the cap is a threshold, not a blanket reject)", async () => {
    const ok = new Uint8Array(gzipSync(Buffer.from(REAL_GOOGLE_XML, "utf8")));
    expect(ok.byteLength).toBeLessThan(10 * 1024 * 1024);

    await expect(decompressReport(ok, "fine.gz")).resolves.toContain("<feedback>");
  });

  it("refuses a zip bomb — caps the DECOMPRESSED size, not just the compressed size", async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x41)));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024); // small on the wire, enormous inflated

    await expect(decompressReport(bomb, "bomb.gz")).rejects.toThrow(ReportError);
  });

  it("rejects garbage that claims to be gzip", async () => {
    const fake = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);

    await expect(decompressReport(fake, "x.gz")).rejects.toThrow(ReportError);
  });
});
