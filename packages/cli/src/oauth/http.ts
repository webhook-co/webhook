// Shared HTTP helpers for the OAuth wire: a form-urlencoded POST (the shape `/token`, `/device_authorization`,
// and `/revoke` all read) and a tolerant parser for the issuer's `{error, error_description?}` body. `fetch`
// is injected so every wire module is unit-tested with a fake — no network.

import { sanitizeControl } from "../output/safe-text.js";

export interface OAuthFetch {
  readonly fetch: typeof fetch;
}

/** POST an `application/x-www-form-urlencoded` body. The caller inspects the Response status itself. */
export async function postForm(
  deps: OAuthFetch,
  url: string,
  params: Record<string, string>,
): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
}

/** Read an OAuth error body `{error, error_description?}`. Falls back to a synthetic code on a non-JSON or
 *  field-less body so a malformed error still yields a usable, closed-taxonomy code. The `error`/`error_description`
 *  are SERVER-controlled and flow into `OAuthError.userMessage` → stderr, which bypasses the text renderers'
 *  `sanitizeControl`; a hostile/compromised issuer could embed terminal-escape bytes, so we strip control bytes
 *  here (the one boundary where attacker-influenced strings enter the OAuth error path). */
export async function readOAuthError(res: Response): Promise<{ code: string; detail?: string }> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { code: `http_${res.status}` };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    const b = body as { error: string; error_description?: unknown };
    return {
      code: sanitizeControl(b.error),
      detail:
        typeof b.error_description === "string" ? sanitizeControl(b.error_description) : undefined,
    };
  }
  return { code: `http_${res.status}` };
}
