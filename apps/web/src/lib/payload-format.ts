// Pure payload-classification helpers shared by the server (the R2 read) and the client (the viewer can
// decide too_large/binary from metadata it already holds, without a server round-trip). No server-only
// imports — safe in the client bundle.

/** Inline-preview ceiling. A body over this is offered as a download, never decoded into the page. */
export const PAYLOAD_INLINE_MAX = 256 * 1024;

const BINARY_CONTENT_TYPE =
  /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-protobuf|x-msgpack|wasm)/i;

/** Whether a content type is known-binary — shown as a download, never decoded as text. */
export function isBinaryContentType(contentType: string | null): boolean {
  return contentType != null && BINARY_CONTENT_TYPE.test(contentType);
}

/** Human-readable byte size for the download affordances. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
