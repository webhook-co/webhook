// DMARC aggregate report decoding — the pure half of the ingestion Worker (ADR-0021, Phase 1).
//
// This module is deliberately paranoid. `reports@wbhk.my` is reachable by anyone who reads our public
// `_dmarc` record, so every byte here is untrusted input from an effectively-open mailbox. Two failure
// modes drive the design:
//
//   1. SILENT EMPTINESS is worse than a crash. A TLS-RPT (JSON) and a DMARC aggregate (XML) arrive at the
//      same catch-all, both gzipped, with near-identical filenames. A TLS-RPT leniently parsed into "zero
//      records" would look exactly like a clean report — and this data is what gates `p=reject`. So every
//      shape we do not positively recognise THROWS. There is no lenient path and no empty-report default.
//   2. Reporters lie about filenames. Container detection reads MAGIC BYTES, never the extension.
//
// On XML: a regex over XML is a latent lie — it passes on today's sample and silently stops matching when
// a reporter reformats. We use a real parser with entity processing DISABLED (XXE: the DTD in an attacker's
// report must never be resolved).

import { XMLParser } from "fast-xml-parser";

/** Raised for every rejected input. Callers distinguish "not for us" from "broken" by message only —
 *  both outcomes are the same operational decision: do not store it, and do not pretend it was clean. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** Cap on the compressed payload we will even look at. */
const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
/** Cap on the INFLATED size. A gzip bomb is small on the wire and enormous inflated, so capping the
 *  compressed size alone is not protection. Real aggregates are single-digit KB. */
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

export interface DkimAuthResult {
  readonly domain: string;
  readonly result: string;
  readonly selector?: string;
}

export interface SpfAuthResult {
  readonly domain: string;
  readonly result: string;
}

export interface AggregateRecord {
  readonly sourceIp: string;
  readonly count: number;
  readonly disposition: string;
  /** The DMARC-evaluated verdict — this, not the raw auth_results, is what the receiver acted on. */
  readonly dkimEvaluated: string;
  readonly spfEvaluated: string;
  readonly headerFrom: string;
  /** EVERY dkim block, in order. Resend and Stripe both ride Amazon SES, so a second d=amazonses.com
   *  signature is routine — collapsing this to one entry would hide a genuinely unknown signer. */
  readonly dkimAuth: readonly DkimAuthResult[];
  readonly spfAuth: readonly SpfAuthResult[];
}

export interface PolicyPublished {
  readonly p: string;
  readonly sp?: string;
  readonly np?: string;
  readonly adkim?: string;
  readonly aspf?: string;
}

export interface AggregateReport {
  readonly orgName: string;
  readonly reportId: string;
  readonly domain: string;
  readonly dateRangeBegin: number;
  readonly dateRangeEnd: number;
  readonly policyPublished: PolicyPublished;
  readonly records: readonly AggregateRecord[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // XXE defence: never resolve entities declared in an inbound DTD.
  processEntities: false,
  // Everything we read is a string or an int we coerce ourselves; letting the parser guess types turns
  // a report_id like 7545198205576254510 into a lossy float.
  parseTagValue: false,
  trimValues: true,
});

/** Coerce a parsed node to a single value, tolerating the parser collapsing single-element arrays. */
function one(node: unknown): unknown {
  return Array.isArray(node) ? node[0] : node;
}

/** Coerce a parsed node to an array, tolerating a single element arriving unwrapped. */
function many(node: unknown): unknown[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

function str(node: unknown, field: string): string {
  const v = one(node);
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  throw new ReportError(`missing or non-scalar field: ${field}`);
}

function optStr(node: unknown): string | undefined {
  const v = one(node);
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function int(node: unknown, field: string): number {
  const raw = str(node, field);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ReportError(`field is not a number: ${field}`);
  return n;
}

/**
 * Parse a DMARC aggregate report. Throws {@link ReportError} for anything that is not positively a
 * `<feedback>` document carrying at least one record — including a TLS-RPT, which is the confusable case.
 */
export function parseAggregateReport(xml: string): AggregateReport {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    throw new ReportError("empty report body");
  }

  // A TLS-RPT is JSON and arrives in the same mailbox, gzipped, named almost identically. Catch it by
  // shape before the XML parser turns it into an unrecognisable object.
  const head = xml.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    throw new ReportError("body is JSON (likely a TLS-RPT), not a DMARC aggregate");
  }

  // fast-xml-parser does not resolve entities with processEntities:false, but an inbound DOCTYPE has no
  // legitimate reason to appear in an aggregate at all. Refuse it outright rather than rely on a flag.
  if (/<!DOCTYPE/i.test(xml)) {
    throw new ReportError("report declares a DOCTYPE; refusing (XXE)");
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (cause) {
    throw new ReportError(`unparseable XML: ${(cause as Error).message}`);
  }

  const feedback = one(doc?.feedback) as Record<string, unknown> | undefined;
  if (!feedback || typeof feedback !== "object") {
    throw new ReportError("not a DMARC aggregate: no <feedback> root");
  }

  const meta = one(feedback.report_metadata) as Record<string, unknown> | undefined;
  const policy = one(feedback.policy_published) as Record<string, unknown> | undefined;
  if (!meta || !policy) {
    throw new ReportError("not a DMARC aggregate: missing report_metadata or policy_published");
  }

  const range = one(meta.date_range) as Record<string, unknown> | undefined;
  if (!range) throw new ReportError("missing date_range");

  const rawRecords = many(feedback.record);
  if (rawRecords.length === 0) {
    // An aggregate with no records is not "clean" — it is a document we do not understand. Returning an
    // empty report here would launder unknown input into a green signal.
    throw new ReportError("aggregate contains no <record> entries");
  }

  const records = rawRecords.map((entry) => parseRecord(entry as Record<string, unknown>));

  return {
    orgName: str(meta.org_name, "org_name"),
    reportId: str(meta.report_id, "report_id"),
    domain: str(policy.domain, "policy_published.domain"),
    dateRangeBegin: int(range.begin, "date_range.begin"),
    dateRangeEnd: int(range.end, "date_range.end"),
    policyPublished: {
      p: str(policy.p, "policy_published.p"),
      sp: optStr(policy.sp),
      np: optStr(policy.np),
      adkim: optStr(policy.adkim),
      aspf: optStr(policy.aspf),
    },
    records,
  };
}

function parseRecord(entry: Record<string, unknown>): AggregateRecord {
  const row = one(entry.row) as Record<string, unknown> | undefined;
  if (!row) throw new ReportError("record is missing <row>");

  const evaluated = one(row.policy_evaluated) as Record<string, unknown> | undefined;
  if (!evaluated) throw new ReportError("record is missing <policy_evaluated>");

  const identifiers = one(entry.identifiers) as Record<string, unknown> | undefined;
  const auth = one(entry.auth_results) as Record<string, unknown> | undefined;

  const dkimAuth = many(auth?.dkim).map((d) => {
    const node = d as Record<string, unknown>;
    return {
      domain: str(node.domain, "auth_results.dkim.domain"),
      result: str(node.result, "auth_results.dkim.result"),
      selector: optStr(node.selector),
    };
  });

  const spfAuth = many(auth?.spf).map((s) => {
    const node = s as Record<string, unknown>;
    return {
      domain: str(node.domain, "auth_results.spf.domain"),
      result: str(node.result, "auth_results.spf.result"),
    };
  });

  return {
    sourceIp: str(row.source_ip, "row.source_ip"),
    count: int(row.count, "row.count"),
    disposition: str(evaluated.disposition, "policy_evaluated.disposition"),
    dkimEvaluated: str(evaluated.dkim, "policy_evaluated.dkim"),
    spfEvaluated: str(evaluated.spf, "policy_evaluated.spf"),
    headerFrom: str(identifiers?.header_from, "identifiers.header_from"),
    dkimAuth,
    spfAuth,
  };
}

/** Inflate a stream, refusing to buffer more than {@link MAX_DECOMPRESSED_BYTES}. */
async function inflate(bytes: Uint8Array, format: "gzip" | "deflate-raw"): Promise<Uint8Array> {
  // A ReadableStream rather than Blob#stream(): Blob/BlobPart are DOM lib types absent from
  // @cloudflare/workers-types, and this keeps the source a single well-typed chunk.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream(format));

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        // Bail mid-stream: the point is to never materialise the bomb, not to measure it afterwards.
        await reader.cancel();
        throw new ReportError("decompressed payload exceeds cap (possible zip bomb)");
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof ReportError) throw cause;
    throw new ReportError(`decompression failed: ${(cause as Error).message}`);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Extract the single deflate member from a ZIP. `DecompressionStream` has no zip support — zip is a
 * container, not a codec — and Google, Microsoft and Yahoo all send `.zip`. Treating it as gzip fails at
 * the header, which would silently drop the majority of real reports.
 */
async function unzipFirstMember(bytes: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 30) throw new ReportError("truncated zip");

  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const start = 30 + nameLength + extraLength;

  let compressedSize = view.getUint32(18, true);
  const flags = view.getUint16(6, true);
  // Bit 3 => sizes live in a trailing data descriptor, not the local header. Fall back to "rest of the
  // archive up to the central directory" rather than trusting a zero.
  if (compressedSize === 0 || (flags & 0x08) !== 0) {
    const central = indexOfSignature(bytes, [0x50, 0x4b, 0x01, 0x02], start);
    compressedSize = (central === -1 ? bytes.byteLength : central) - start;
  }
  if (start + compressedSize > bytes.byteLength)
    throw new ReportError("zip member overruns the archive");

  const member = bytes.subarray(start, start + compressedSize);

  if (method === 0) return member; // stored
  if (method !== 8) throw new ReportError(`unsupported zip compression method: ${method}`);
  return inflate(member, "deflate-raw");
}

function indexOfSignature(haystack: Uint8Array, sig: readonly number[], from: number): number {
  outer: for (let i = from; i <= haystack.byteLength - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (haystack[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Decode a report attachment into XML text, handling `.gz`, `.zip` and bare XML.
 *
 * `filename` is accepted for diagnostics ONLY — the container is detected from magic bytes, because
 * reporters mislabel attachments and a filename is attacker-controlled.
 */
export async function decompressReport(bytes: Uint8Array, _filename: string): Promise<string> {
  if (bytes.byteLength === 0) throw new ReportError("empty attachment");
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new ReportError("attachment exceeds cap");
  }

  let raw: Uint8Array;
  if (startsWith(bytes, GZIP_MAGIC)) {
    raw = await inflate(bytes, "gzip");
  } else if (startsWith(bytes, ZIP_MAGIC)) {
    raw = await unzipFirstMember(bytes);
  } else {
    raw = bytes;
  }

  return new TextDecoder("utf-8").decode(raw);
}
