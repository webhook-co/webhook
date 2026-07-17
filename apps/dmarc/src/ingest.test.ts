import { describe, expect, it } from "vitest";

import { selectReportAttachment, type CandidateAttachment } from "./ingest.js";

const GZ = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const XML = new TextEncoder().encode('<?xml version="1.0"?><feedback></feedback>');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function att(filename: string, mimeType: string, content: Uint8Array): CandidateAttachment {
  return { filename, mimeType, content };
}

describe("selectReportAttachment", () => {
  it("picks a .zip report — every real fixture in this lane arrived as a zip", () => {
    const picked = selectReportAttachment([
      att("google.com!webhook.co!1784160000!1784246399.zip", "application/zip", ZIP),
    ]);

    expect(picked?.filename).toContain(".zip");
  });

  it("picks a .gz report", () => {
    expect(selectReportAttachment([att("r.xml.gz", "application/gzip", GZ)])?.filename).toBe(
      "r.xml.gz",
    );
  });

  it("picks bare XML", () => {
    expect(selectReportAttachment([att("r.xml", "text/xml", XML)])?.filename).toBe("r.xml");
  });

  it("ignores an inline image and still finds the report beside it", () => {
    // A forwarded message routinely carries signature images and the wrapper's own parts. Taking the
    // FIRST attachment would grab a logo and report the mail as unparseable.
    const picked = selectReportAttachment([
      att("signature.png", "image/png", PNG),
      att("report.xml.gz", "application/gzip", GZ),
    ]);

    expect(picked?.filename).toBe("report.xml.gz");
  });

  it("selects on MAGIC BYTES even when the reporter mislabels the extension", () => {
    // Reporters mislabel; filenames are attacker-controlled. Content is the only thing that holds.
    const picked = selectReportAttachment([att("report.txt", "application/octet-stream", ZIP)]);

    expect(picked?.filename).toBe("report.txt");
  });

  it("rejects an attachment whose CONTENT is an image even if it is named .gz", () => {
    expect(selectReportAttachment([att("sneaky.gz", "application/gzip", PNG)])).toBeUndefined();
  });

  it("returns undefined when nothing looks like a report, rather than guessing", () => {
    // A forward with no report attachment is a real case (a stray mail to reports@). Guessing here would
    // manufacture a parse error and bury the fact that nothing arrived.
    expect(selectReportAttachment([att("cat.png", "image/png", PNG)])).toBeUndefined();
    expect(selectReportAttachment([])).toBeUndefined();
  });

  it("skips a zero-byte attachment", () => {
    expect(
      selectReportAttachment([att("empty.gz", "application/gzip", new Uint8Array())]),
    ).toBeUndefined();
  });

  it("prefers the FIRST report-shaped attachment when several are present", () => {
    const picked = selectReportAttachment([
      att("a.zip", "application/zip", ZIP),
      att("b.xml.gz", "application/gzip", GZ),
    ]);

    expect(picked?.filename).toBe("a.zip");
  });
});
