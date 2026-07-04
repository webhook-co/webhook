// Decode the base64 payload envelope (ADR-0015: raw webhook bodies ride the JSON wire as base64) back to
// exact bytes. Uses the web-standard `atob`, available on every target runtime (Node 18+, browsers,
// Workers, Deno). Malformed input surfaces as an unexpected-response error rather than a raw DOMException.

import { WebhookUnexpectedResponseError } from "./errors.js";

export function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new WebhookUnexpectedResponseError("the API returned a malformed base64 payload");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
