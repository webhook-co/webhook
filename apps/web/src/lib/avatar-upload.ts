/**
 * Client → server transport for a cropped avatar.
 *
 * The body is a RAW `image/webp` blob (not multipart/form-data), which is deliberate: a raw non-simple
 * content type forces the browser to send a CORS preflight for any cross-origin caller, and the route also
 * checks `Origin` explicitly — route handlers get no framework CSRF guard. The bytes were already cropped to a
 * square 512×512 webp on the client; the server re-validates magic bytes + dimensions regardless (never trust
 * the client's re-encode).
 */
export type UploadResult = { ok: true } | { ok: false; error: string };

/** Server status → a message a human can act on. The route's own copy is not surfaced to the client. */
function messageFor(status: number): string {
  switch (status) {
    case 413:
      return "That image is too large — pick a smaller one.";
    case 415:
      return "That file isn't a supported image. Use a square PNG, JPEG, or webp.";
    case 403:
      return "Your session expired. Refresh the page and try again.";
    case 503:
      return "Photo uploads are temporarily unavailable. Try again shortly.";
    default:
      return "We couldn't save your photo. Try again in a moment.";
  }
}

export async function uploadAvatarWebp(
  blob: Blob,
  opts: { signal?: AbortSignal } = {},
): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetch("/api/avatar/upload", {
      method: "POST",
      // The session cookie gates the route — it must ride along.
      credentials: "same-origin",
      headers: { "Content-Type": "image/webp" },
      body: blob,
      signal: opts.signal,
    });
  } catch {
    // Offline, DNS, aborted-as-network. Never let a rejected fetch bubble as an unhandled crash in the dialog.
    return { ok: false, error: "Upload failed — check your connection and try again." };
  }
  if (!res.ok) return { ok: false, error: messageFor(res.status) };
  return { ok: true };
}
