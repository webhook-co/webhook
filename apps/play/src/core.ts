// Pure, runtime-agnostic core for the /play sandbox — no Durable Object, no bindings, so every
// security-relevant rule (token entropy, absolute TTL, body caps, constant-time compare, SSE
// framing) is unit-testable without workerd. The Durable Object (play-session.ts) and the Worker
// (index.ts) are thin shells over this.
//
// SECURITY MODEL (see the threat model in the PR): /play is a PUBLIC, UNAUTHENTICATED capture
// sandbox. It must never become a paste-bin, a phishing host, or an XSS vector on the trust brand.
// The controls that live HERE:
//   - Ingest tokens and viewer secrets are 128-bit CSPRNG (unguessable / un-enumerable).
//   - Viewing is SESSION-BOUND: the ingest token (shareable, what you POST to) is SEPARATE from the
//     viewer secret (held only by the minting browser). A bare token URL cannot stream content, so
//     an attacker can't broadcast a captured payload to a third party via a shared link.
//   - ABSOLUTE TTL: a token dies at mintedAt + TTL regardless of activity — capture cannot extend it,
//     so /play can't be held open as an indefinite dead-drop, and "auto-deletes in minutes" is TRUE.
//   - Bodies are capped small (utility as a file host is low) and transmitted as inert JSON.

/** 128-bit tokens: unguessable and non-enumerable. */
export const TOKEN_BYTES = 16;
/** Hard lifetime from mint. Activity does NOT extend it — the "deletes in minutes" promise must hold. */
export const ABSOLUTE_TTL_MS = 15 * 60_000;
/** Per-token capture cap — bounds a token's use as a stream/dead-drop. */
export const MAX_REQUESTS_PER_TOKEN = 100;
/** Body cap: deliberately small. A sandbox demo needs a few KB; a file host wants megabytes. */
export const BODY_CAP_BYTES = 16 * 1024;

/** A hex string of `bytes` cryptographically-random bytes. Uses the platform CSPRNG (workerd/node). */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The ingest token — the shareable path segment tools POST to (play.wbhk.my/<token>). */
export function newIngestToken(): string {
  return randomHex(TOKEN_BYTES);
}

/** The viewer secret — returned ONLY to the minting browser; required to open the stream. */
export function newViewerSecret(): string {
  return randomHex(TOKEN_BYTES);
}

/**
 * Constant-time string comparison, to keep the viewer-secret check free of a timing oracle. Both
 * inputs are fixed-length hex here, so comparing lengths first leaks nothing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CaptureRecord {
  /** Per-capture id (ordering + React keys). */
  readonly id: string;
  readonly method: string;
  /** Header name/value pairs, in received order. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly contentType: string | null;
  /** The body, decoded lossily as UTF-8 and capped. Rendered as INERT text by the client. */
  readonly body: string;
  readonly bodyBytes: number;
  /** True when the body exceeded BODY_CAP_BYTES and was truncated. */
  readonly truncated: boolean;
  /** Epoch ms the request was captured. */
  readonly receivedAt: number;
}

/** Decode a body to inert text, capped at `cap` bytes. Binary bytes become U+FFFD — never executed. */
export function capBody(
  bytes: Uint8Array,
  cap = BODY_CAP_BYTES,
): { text: string; truncated: boolean; bodyBytes: number } {
  const truncated = bytes.length > cap;
  const slice = truncated ? bytes.subarray(0, cap) : bytes;
  // `fatal: false` (default) → invalid sequences become the replacement char, so arbitrary binary
  // is rendered as harmless text rather than throwing or smuggling control bytes.
  const text = new TextDecoder("utf-8").decode(slice);
  return { text, truncated, bodyBytes: bytes.length };
}

/** Build a capture record from the raw request parts. Pure — the DO supplies id/receivedAt/bytes. */
export function buildCaptureRecord(input: {
  id: string;
  method: string;
  headers: Iterable<readonly [string, string]>;
  bodyBytes: Uint8Array;
  receivedAt: number;
}): CaptureRecord {
  const { text, truncated, bodyBytes } = capBody(input.bodyBytes);
  const headers: Array<readonly [string, string]> = [];
  let contentType: string | null = null;
  for (const [name, value] of input.headers) {
    headers.push([name, value]);
    if (name.toLowerCase() === "content-type") contentType = value;
  }
  return {
    id: input.id,
    method: input.method,
    headers,
    contentType,
    body: text,
    bodyBytes,
    truncated,
    receivedAt: input.receivedAt,
  };
}

/** A token minted at `mintedAt` is expired once now ≥ mintedAt + ttl. Absolute, activity-independent. */
export function isExpired(mintedAt: number, now: number, ttl = ABSOLUTE_TTL_MS): boolean {
  return now >= mintedAt + ttl;
}

/**
 * Encode a capture as ONE Server-Sent-Events frame. The whole record is JSON-encoded onto a single
 * `data:` line — JSON escapes newlines/control chars, so an attacker-controlled body can't inject a
 * second SSE frame (stream spoofing) or break framing. The client parses the JSON; it never trusts
 * raw framing.
 */
export function sseFrame(record: CaptureRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`;
}

/** An SSE comment line — used as a keepalive that carries no data. */
export function sseComment(text: string): string {
  return `: ${text.replace(/\n/g, " ")}\n\n`;
}
