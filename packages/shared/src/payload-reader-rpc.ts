// The engine's PayloadReader service-binding contract (S5 Slice C2). The MCP worker deliberately has NO R2
// binding (confused-deputy / no-broad-R2 posture, ADR-0015), so triggers.wait fetches a BOUNDED inline
// payload body through this narrow, org-scoped, size-capped engine RPC — mirroring IngestUrlRevealer (the
// KEK never leaves the engine; here the R2 bucket never leaves the engine). Identifier-only: the caller
// passes its authenticated orgId + event ids, and the engine reads each event's stored payload key UNDER
// THE ORG'S RLS itself (never a caller-supplied key), fences it with readPayloadKey, then range-reads at
// most `maxBytesEach` bytes from R2. A cross-org / unknown event id resolves to `found:false` (no leak).

import { bytesToB64 } from "./bytes";

/** The largest inline body triggers.wait will ever return per event (server cap). */
export const MAX_INLINE_BODY_BYTES = 65_536; // 64 KiB

/** One event's bounded inline body. */
export interface BoundedPayloadBody {
  readonly eventId: string;
  /** false = the event is unknown/cross-org (RLS) OR has no stored R2 object OR its key failed the fence. */
  readonly found: boolean;
  /** The (bounded) body as a string, or null when !found. `encoding` says how to interpret it. */
  readonly body: string | null;
  /** `utf8` = the returned bytes are valid UTF-8 (return them verbatim); `base64` = binary/partial, decode. */
  readonly encoding: "utf8" | "base64";
  /** Bytes actually returned (≤ maxBytesEach). */
  readonly byteLength: number;
  /** True when the stored payload is larger than the returned slice (the body is a prefix). */
  readonly truncated: boolean;
  /** The captured request's content-type, or null. */
  readonly contentType: string | null;
}

export interface ReadBoundedBodiesArgs {
  /** The authenticated caller's org — the engine scopes the event lookup to it under RLS. */
  readonly orgId: string;
  readonly eventIds: readonly string[];
  /** Per-event byte cap; the engine additionally clamps to MAX_INLINE_BODY_BYTES. */
  readonly maxBytesEach: number;
}

export interface PayloadReaderRpc {
  readBoundedBodies(args: ReadBoundedBodiesArgs): Promise<BoundedPayloadBody[]>;
}

/**
 * Turn a bounded byte slice into a triggers.wait body field (PURE). Returns the bytes as a verbatim UTF-8
 * string when they are fully-valid UTF-8 (the common case — JSON/text webhooks), else base64 (binary, or a
 * multibyte char cut by truncation). `truncated` = the stored payload is longer than what we read.
 */
export function boundedBodyFromBytes(
  bytes: Uint8Array,
  storedByteLength: number,
): { body: string; encoding: "utf8" | "base64"; byteLength: number; truncated: boolean } {
  // We returned fewer bytes than are stored ⇒ the body is a prefix (a larger payload was clipped to the cap).
  const truncated = bytes.byteLength < storedByteLength;
  try {
    // `fatal: true` throws on any invalid UTF-8 (binary, or a multibyte char cut by truncation) → we fall
    // back to base64. The cast bridges a workers-types gap: TextDecoderConstructorOptions omits `fatal`,
    // which workerd (and the DOM) fully support at runtime.
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
    } as unknown as ConstructorParameters<typeof TextDecoder>[1]);
    return {
      body: decoder.decode(bytes),
      encoding: "utf8",
      byteLength: bytes.byteLength,
      truncated,
    };
  } catch {
    return { body: bytesToB64(bytes), encoding: "base64", byteLength: bytes.byteLength, truncated };
  }
}
