import { LOOPBACK_HOSTS } from "./api-client.js";
import { InvalidForwardUrlError } from "./errors.js";

// Forward a captured webhook to a local dev server (the replay-to-localhost wedge). The CLI performs
// the POST (the api can't reach a user's machine); the body is sent as EXACT bytes and the captured
// headers pass through (minus hop-by-hop) so the provider signature still verifies (Standard Webhooks
// fidelity). The target MUST be loopback http(s) — a captured payload + its signature must never be
// sent off the machine.

// Hop-by-hop + length/host headers the fetch must own; everything else (incl. the webhook-* signature
// headers) is forwarded verbatim. RFC 7230 §6.1 hop-by-hop set + host/content-length.
const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Filter captured [name,value] pairs for forwarding: drop hop-by-hop/host/length, keep the rest. */
export function filterForwardHeaders(captured: readonly (readonly [string, string])[]): Headers {
  const out = new Headers();
  for (const [name, value] of captured) {
    if (!DROP_HEADERS.has(name.toLowerCase())) out.append(name, value);
  }
  return out;
}

/** Validate a --forward target: http(s):// at a loopback host. Throws InvalidForwardUrlError otherwise. */
export function parseForwardTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidForwardUrlError(raw);
  }
  const httpish = url.protocol === "http:" || url.protocol === "https:";
  if (!httpish || !LOOPBACK_HOSTS.has(url.hostname)) throw new InvalidForwardUrlError(raw);
  return url;
}

export type ForwardOutcome =
  | { readonly ok: true; readonly status: number; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: string };

export interface ForwardInput {
  readonly targetUrl: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface ForwardSeams {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/**
 * POST the captured event to the loopback target. Returns `{ok:true,status}` when the local server
 * responds (ANY status — the caller decides 2xx-vs-not), or `{ok:false,reason}` when the connection
 * itself fails (refused/timeout/DNS) so a streaming caller can retry without crashing the CLI. The
 * target is validated as loopback first (throws InvalidForwardUrlError — a usage error).
 */
export async function forwardToLocalhost(
  seams: ForwardSeams,
  input: ForwardInput,
): Promise<ForwardOutcome> {
  parseForwardTarget(input.targetUrl); // throws on a non-loopback target
  const headers = filterForwardHeaders(input.headers);
  const started = seams.now();
  try {
    const res = await seams.fetch(input.targetUrl, {
      method: "POST",
      headers,
      // Uint8Array is a valid fetch body at runtime; cast via the fetch param type (no DOM `BodyInit`).
      body: input.body,
      // NEVER auto-follow a 3xx: the loopback guard only validated the initial URL, so following a
      // redirect could re-send the captured payload + provider signature to an off-machine host. A
      // 3xx surfaces as the local response (status 3xx → not delivered), the same as any non-2xx.
      redirect: "manual",
    } as Parameters<typeof fetch>[1]);
    return {
      ok: true,
      status: res.status,
      latencyMs: Math.max(0, Math.round(seams.now() - started)),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A 2xx local response = a successful delivery (the cursor-gate for streaming forward). */
export function isDelivered(outcome: ForwardOutcome): boolean {
  return outcome.ok && outcome.status >= 200 && outcome.status < 300;
}
