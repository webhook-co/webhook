// The config-driven adapter factory. `makeHmacAdapter` turns one declarative HmacProviderConfig
// (./config) into a VerifyAdapter, routing every provider through the SAME audited engine
// (`verifyHmacCore`, via `verifyHmac` in ./shared). This is the seam that lets a new
// provider be one config row instead of a hand-written adapter — there is no per-provider crypto.
//
// Diagnosis order: MISSING_HEADER → oversize → signature-parse / timestamp-format /
// referenced-header (all MALFORMED_SIGNATURE) → replay-window (TIMESTAMP_*) → HMAC. Every structural
// (header-shape) problem is surfaced BEFORE the skew check — ONE consistent order for every provider.
// This matches the hand-written Stripe/Slack adapters exactly, and applies the same order to Standard
// Webhooks (whose bespoke adapter checked the replay window before parsing signatures): a request
// that is BOTH stale and missing a v1 signature reports MALFORMED_SIGNATURE rather than
// TIMESTAMP_TOO_OLD — both reject; the structural reason is the more actionable one. (A not-valid
// hex/base64 signature is diagnosed inside verifyHmacCore, i.e. after the skew check.)

import { concatBytes, utf8Encoder } from "../bytes";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import {
  RAW_BODY_MESSAGE,
  type HmacProviderConfig,
  type SignatureFormat,
  type TimestampSource,
} from "./config";
import {
  enforceSkew,
  findHeader,
  oversizeBodyFailure,
  toCandidates,
  toHexKeyCandidates,
  toStandardWebhooksCandidates,
  verifyHmac,
} from "./shared";

interface ParsedSignatureHeader {
  /** Every signature present in the header (rotation / multi-sig). */
  readonly signatures: string[];
  /** `key=value` fields parsed out of the header (csvKv only; e.g. Stripe's `t`). */
  readonly fields: Record<string, string>;
}

/** Parse the signature header into its signatures (+ any embedded fields). String = MALFORMED detail. */
function parseSignatureHeader(
  headerValue: string,
  format: SignatureFormat,
  prefix: string | undefined,
): ParsedSignatureHeader | { error: string } {
  switch (format.kind) {
    case "plain": {
      let value = headerValue;
      if (prefix !== undefined) {
        if (!headerValue.startsWith(prefix)) return { error: `expected "${prefix}" prefix` };
        value = headerValue.slice(prefix.length);
      }
      return { signatures: [value], fields: {} };
    }
    case "csvKv": {
      const fields: Record<string, string> = {};
      const signatures: string[] = [];
      // Comma-delimited by default (Stripe `t=,v1=`); Paddle uses a semicolon (`ts=;h1=`).
      for (const part of headerValue.split(format.delimiter ?? ",")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (key === format.sigKey) signatures.push(val);
        else fields[key] = val;
      }
      if (signatures.length === 0) return { error: `missing ${format.sigKey}=` };
      return { signatures, fields };
    }
    case "spaceList": {
      const signatures: string[] = [];
      for (const entry of headerValue.split(" ")) {
        if (entry === "") continue;
        const comma = entry.indexOf(",");
        if (comma === -1) continue;
        if (entry.slice(0, comma) === format.sigTag) signatures.push(entry.slice(comma + 1));
      }
      if (signatures.length === 0) return { error: `no ${format.sigTag} signatures` };
      return { signatures, fields: {} };
    }
    case "positional": {
      // A comma-separated list whose FIRST element is the timestamp and the rest are signatures
      // (Recurly: `<unix>,<sig1>,<sig2>`). The timestamp is exposed as `timestampField` so the
      // standard sigField timestamp/replay machinery drives it.
      const items = headerValue.split(",").map((p) => p.trim());
      if (items.length < 2 || items[0] === "")
        return { error: "expected timestamp + signature(s)" };
      const signatures = items.slice(1).filter((p) => p.length > 0);
      if (signatures.length === 0) return { error: "no signatures" };
      return { signatures, fields: { [format.timestampField]: items[0]! } };
    }
  }
}

/**
 * Collect signatures from numbered headers `<prefix>1` … `<prefix>max` (DocuSign Connect: one base64
 * MAC per configured key). Each present, non-empty header IS one complete signature; gaps are tolerated
 * (a missing index doesn't stop the scan). Returns every signature found, in index order.
 */
function collectNumberedSignatures(
  input: VerifyInput,
  source: { prefix: string; max: number },
): string[] {
  const signatures: string[] = [];
  for (let i = 1; i <= source.max; i++) {
    const value = findHeader(input.headers, `${source.prefix}${i}`);
    if (value !== undefined && value.trim() !== "") signatures.push(value.trim());
  }
  return signatures;
}

/**
 * Resolve the signed timestamp. `null` = the scheme has none; string = MALFORMED detail. `tsRaw` is
 * used VERBATIM in the signed message (whatever the provider signs); `epochSeconds` drives the replay
 * window — so a milliseconds or ISO-8601/RFC3339 datetime timestamp verifies correctly even though the
 * raw string (not an integer-seconds value) is what goes into the HMAC.
 */
function resolveTimestamp(
  source: TimestampSource,
  input: VerifyInput,
  fields: Record<string, string>,
): { tsRaw: string; epochSeconds: number } | null | { error: string } {
  if (source.kind === "none") return null;
  const raw =
    source.kind === "header" ? findHeader(input.headers, source.header) : fields[source.field];
  if (raw === undefined) {
    return {
      error: source.kind === "header" ? `missing ${source.header}` : `missing ${source.field}=`,
    };
  }
  const label = source.kind === "header" ? source.header : source.field;
  const fmt = source.format ?? "seconds";
  if (fmt === "datetime") {
    // ISO-8601 / RFC3339 (e.g. Zendesk, Twitch). Signed verbatim; Date.parse gives the epoch for the
    // replay check (it tolerates fractional/nanosecond seconds, truncating to ms).
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return { error: `unparseable ${label}` };
    return { tsRaw: raw, epochSeconds: Math.floor(ms / 1000) };
  }
  // seconds / milliseconds: require a canonical integer (Number.parseInt is lenient); a non-canonical
  // or garbage timestamp is MALFORMED, never a silently-skipped replay check.
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw) return { error: `non-integer ${label}` };
  return { tsRaw: raw, epochSeconds: fmt === "milliseconds" ? Math.floor(n / 1000) : n };
}

export function makeHmacAdapter(config: HmacProviderConfig): VerifyAdapter {
  const scheme = config.slug;
  const header = config.signatureHeader;
  const parts = config.message ?? RAW_BODY_MESSAGE;
  const format = config.signatureFormat ?? { kind: "plain" };
  const tsSource: TimestampSource = config.timestamp ?? { kind: "none" };
  const keyMode = config.keyDerivation ?? "utf8";
  const digest = config.digest ?? "sha256";
  const enforceWindow = config.enforceReplayWindow ?? true;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    // Collect the signature(s) (presence = MISSING_HEADER). Numbered schemes (DocuSign) gather one
    // signature per `<prefix>N` header; everyone else parses the single signature header value. The
    // diagnosis order — MISSING_HEADER → oversize → signature-parse — is identical for both.
    let signatures: string[];
    let sigFields: Record<string, string> = {};
    if (config.numberedSignatureHeaders) {
      signatures = collectNumberedSignatures(input, config.numberedSignatureHeaders);
      if (signatures.length === 0) {
        return verificationFailed({ code: "MISSING_HEADER", header, scheme });
      }
      const oversize = oversizeBodyFailure(scheme, input.rawBody);
      if (oversize !== null) return oversize;
    } else {
      const headerValue = findHeader(input.headers, header);
      if (headerValue === undefined) {
        return verificationFailed({ code: "MISSING_HEADER", header, scheme });
      }
      const oversize = oversizeBodyFailure(scheme, input.rawBody);
      if (oversize !== null) return oversize;
      const parsed = parseSignatureHeader(headerValue, format, config.signatureValuePrefix);
      if ("error" in parsed) {
        return verificationFailed({ code: "MALFORMED_SIGNATURE", detail: parsed.error, scheme });
      }
      signatures = parsed.signatures;
      sigFields = parsed.fields;
    }

    // Resolve (and format-validate) the timestamp, but DON'T enforce the window yet.
    const ts = resolveTimestamp(tsSource, input, sigFields);
    if (ts !== null && "error" in ts) {
      return verificationFailed({ code: "MALFORMED_SIGNATURE", detail: ts.error, scheme });
    }

    // Resolve every non-body message part to bytes (a referenced header that's absent is MALFORMED).
    // `null` marks the body placeholder, substituted per-call so the engine's mutation probes work.
    const resolved: (Uint8Array | null)[] = [];
    for (const part of parts) {
      if (part.kind === "body") {
        resolved.push(null);
        continue;
      }
      let value: string;
      if (part.kind === "literal") {
        value = part.value;
      } else if (part.kind === "timestamp") {
        if (ts === null) {
          // A `timestamp` part with no timestamp source is a config bug; fail closed, never throw.
          return verificationFailed({
            code: "MALFORMED_SIGNATURE",
            detail: "missing timestamp",
            scheme,
          });
        }
        value = ts.tsRaw;
      } else {
        const headerVal = findHeader(input.headers, part.header);
        if (headerVal === undefined) {
          return verificationFailed({
            code: "MALFORMED_SIGNATURE",
            detail: `missing ${part.header}`,
            scheme,
          });
        }
        value = headerVal;
      }
      resolved.push(utf8Encoder.encode(value));
    }

    // Enforce the replay window AFTER all structural checks, BEFORE spending HMAC cycles — unless the
    // scheme signs a timestamp but documents no window (Sanity): then the ts is in the message only.
    if (ts !== null && enforceWindow) {
      const skewFailure = enforceSkew(scheme, ts.epochSeconds, input.now);
      if (skewFailure !== null) return skewFailure;
    }

    const buildMessage = (body: Uint8Array): Uint8Array => {
      if (resolved.length === 1 && resolved[0] === null) return body; // raw-body fast path, no copy
      return concatBytes(...resolved.map((r) => (r === null ? body : r)));
    };

    const candidates =
      keyMode === "whsec-base64"
        ? toStandardWebhooksCandidates(input.secrets)
        : keyMode === "hex"
          ? toHexKeyCandidates(input.secrets)
          : toCandidates(input.secrets);

    return verifyHmac({
      scheme,
      rawBody: input.rawBody,
      signatures,
      encoding: config.encoding,
      digest,
      candidates,
      buildMessage,
    });
  }

  return { scheme, signatureHeader: header, toleranceSeconds: config.toleranceSeconds, verify };
}
