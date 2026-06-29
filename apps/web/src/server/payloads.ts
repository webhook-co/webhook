import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { withTenant } from "@webhook-co/db/client";

import { isBinaryContentType, PAYLOAD_INLINE_MAX } from "@/lib/payload-format";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { isUuid } from "./endpoints";
import { getEventForEndpoint } from "./events";

// The event payload BODY surface. Unlike headers (where sensitive VALUES are redacted), the body is the
// content the user came to inspect — it is shown in full. But it is read from R2 lazily and gated by size:
// a small text body renders inline (the preview); a large or binary body is offered as a download instead
// (never inlined into the page). All reads go through getEvent under RLS first (ownership), exactly like
// apps/api's events.getPayload — the R2 key is resolved from the RLS-pinned row, never client-supplied.

/** The body preview the client renders. The R2 key never appears here — it stays server-side. */
export type PayloadResult =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly bytes: number;
      readonly contentType: string | null;
    }
  | { readonly kind: "binary"; readonly bytes: number; readonly contentType: string | null }
  | { readonly kind: "too_large"; readonly bytes: number; readonly contentType: string | null }
  | { readonly kind: "pruned" }
  | { readonly kind: "not_found" }
  | { readonly kind: "error" };

/** Minimal R2 object shape this module uses (a subset of Workers' R2ObjectBody). */
export interface R2PayloadObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly body: ReadableStream;
  readonly size: number;
}

/** The reads the payload surface needs, injectable for tests; the default binds the per-request tenant tx + R2. */
export interface PayloadReaders {
  /** Resolve the event's payload ref under RLS + endpoint scope; null if the endpoint/event isn't the caller's. */
  getEventForPayload(
    orgId: string,
    endpointId: string,
    eventId: string,
  ): Promise<{ payloadR2Key: string; payloadBytes: number; contentType: string | null } | null>;
  getObject(key: string): Promise<R2PayloadObject | null>;
}

/** Decode bytes as STRICT UTF-8 — null if they aren't valid UTF-8 (so a binary / non-UTF-8 body is offered
 *  as a download rather than rendered as U+FFFD mojibake, keeping the preview byte-honest). */
function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The per-request R2 payloads bucket (mirrors db.ts's binding read; throws if the binding is unwired). */
export async function getPayloadsBucket(): Promise<{
  get(key: string): Promise<R2PayloadObject | null>;
}> {
  const { env } = await getCloudflareContext({ async: true });
  const bucket = (env as Record<string, unknown>).R2_PAYLOADS as
    | { get(key: string): Promise<R2PayloadObject | null> }
    | undefined;
  if (!bucket) throw new Error("R2_PAYLOADS binding is not configured");
  return bucket;
}

async function boundReaders(): Promise<PayloadReaders> {
  const bucket = await getPayloadsBucket();
  return {
    getEventForPayload: (orgId, endpointId, eventId) =>
      withTenantDb((app) =>
        withTenant(app, orgId, async (tx) => {
          const e = await getEventForEndpoint(tx, endpointId, eventId);
          return e
            ? {
                payloadR2Key: e.payloadR2Key,
                payloadBytes: e.payloadBytes,
                contentType: e.contentType,
              }
            : null;
        }),
      ),
    getObject: (key) => bucket.get(key),
  };
}

/**
 * Load an event's body for the inline preview. Resolves the event under RLS + endpoint scope, then size-
 * gates: an oversized body returns `too_large` WITHOUT touching R2; a known-binary content type returns
 * `binary` without decoding; otherwise R2 is read and a STRICT UTF-8 decode falls back to `binary` for any
 * non-text bytes. A missing R2 object for a present row is `pruned`. A wiring/db/R2 fault (incl. an
 * unresolved R2 binding) is `error` — the bucket resolution is inside the try so it's logged + typed.
 * Tests inject `readers`.
 */
export async function loadEventPayload(
  orgId: string,
  endpointId: string,
  eventId: string,
  readers?: PayloadReaders,
): Promise<PayloadResult> {
  if (!isUuid(endpointId) || !isUuid(eventId)) return { kind: "not_found" };
  try {
    const r = readers ?? (await boundReaders());
    const meta = await r.getEventForPayload(orgId, endpointId, eventId);
    if (!meta) return { kind: "not_found" };
    const { payloadBytes, contentType } = meta;
    if (payloadBytes > PAYLOAD_INLINE_MAX)
      return { kind: "too_large", bytes: payloadBytes, contentType };
    if (isBinaryContentType(contentType))
      return { kind: "binary", bytes: payloadBytes, contentType };
    const obj = await r.getObject(meta.payloadR2Key);
    if (obj === null) return { kind: "pruned" };
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const text = decodeUtf8Strict(bytes);
    if (text === null) return { kind: "binary", bytes: payloadBytes, contentType };
    return { kind: "text", text, bytes: bytes.byteLength, contentType };
  } catch (error) {
    logActionError("events.payload_failed", error);
    return { kind: "error" };
  }
}

/**
 * Open an event's body for download — the full bytes, any size/type, streamed. Resolves the event under
 * RLS + endpoint scope, then returns the R2 object's stream + size + content type, or a sentinel. The R2
 * key never leaves this module. Tests inject `readers`.
 */
export async function openPayloadForDownload(
  orgId: string,
  endpointId: string,
  eventId: string,
  readers?: PayloadReaders,
): Promise<
  { stream: ReadableStream; size: number; contentType: string | null } | "not_found" | "error"
> {
  if (!isUuid(endpointId) || !isUuid(eventId)) return "not_found";
  try {
    const r = readers ?? (await boundReaders());
    const meta = await r.getEventForPayload(orgId, endpointId, eventId);
    if (!meta) return "not_found";
    const obj = await r.getObject(meta.payloadR2Key);
    if (obj === null) return "not_found";
    return { stream: obj.body, size: obj.size, contentType: meta.contentType };
  } catch (error) {
    logActionError("events.payload_download_failed", error);
    return "error";
  }
}

const EXT_BY_TYPE: ReadonlyArray<readonly [RegExp, string]> = [
  [/json/i, "json"],
  [/xml/i, "xml"],
  [/x-www-form-urlencoded/i, "txt"],
  [/^text\//i, "txt"],
];

/** A safe download filename extension from the content type (fixed allowlist; defaults to .bin). */
export function downloadExtension(contentType: string | null): string {
  if (contentType) for (const [re, ext] of EXT_BY_TYPE) if (re.test(contentType)) return ext;
  return "bin";
}
