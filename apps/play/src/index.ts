// play.wbhk.my — the no-signup /play webhook sandbox Worker. Mints ephemeral capture tokens, captures
// requests into a per-token Durable Object, and streams them (session-bound) to the minting browser.
//
// ISOLATION INVARIANT (enforced by wrangler.jsonc having no data-plane bindings): this worker touches
// no real org, bills nothing, and makes exactly ONE outbound fetch — the Turnstile siteverify to a
// COMPILE-TIME-CONSTANT Cloudflare URL (no attacker input in the destination → not an SSRF surface).
// It never fetches anything else, so it cannot be an open relay.
import { newIngestToken, newViewerSecret } from "./core";
import { PlayCoordinator } from "./play-coordinator";
import { PlaySession } from "./play-session";

export { PlayCoordinator, PlaySession };

export interface Env {
  PLAY_SESSION: DurableObjectNamespace<PlaySession>;
  PLAY_COORDINATOR: DurableObjectNamespace<PlayCoordinator>;
  /** "on" enforces Turnstile at mint; "off" (dev/tests) skips it. */
  TURNSTILE_MODE: string;
  TURNSTILE_SECRET_KEY?: string;
  PLAY_TTL_MS: string;
  PLAY_MAX_ACTIVE: string;
  PLAY_MAX_PER_IP: string;
}

const WWW_ORIGIN = "https://www.webhook.co";
// The ONLY host this worker ever fetches — a fixed constant, so verifying Turnstile is not SSRF.
const TURNSTILE_SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_RE = /^[0-9a-f]{32}$/;
/** Hard request-size cap: the body read aborts the moment it exceeds this (never fully buffered). */
const INGEST_MAX_BYTES = 64 * 1024;
/** Defence-in-depth headers on every response (this worker's own origin, not covered by www's _headers). */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

/**
 * The browser origin allowed to read /play (with credentials, for the viewer-secret cookie). In prod
 * it's hard-pinned to www; in dev (Turnstile off) the caller's Origin is reflected so a localhost www
 * dev server can reach a local play worker. Never a wildcard.
 */
function allowedOrigin(env: Env, request: Request): string {
  if (env.TURNSTILE_MODE === "on") return WWW_ORIGIN;
  return request.headers.get("origin") ?? WWW_ORIGIN;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Credentials are on for the HttpOnly viewer-secret cookie; origin is exact (never wildcard),
    // so only the pinned www origin can read a stream with credentials.
    "access-control-allow-credentials": "true",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra },
  });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

/**
 * The rate-limit bucket for an IP. IPv4 → the full address; IPv6 → the /64 prefix, because a single
 * attacker routinely controls a whole /64 (2^64 addresses) and a per-exact-IP cap would be
 * meaningless. cf-connecting-ip is set by Cloudflare and cannot be spoofed.
 */
function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4 → /32
  const [head, tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const full = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  return `${full
    .slice(0, 4)
    .map((g) => g || "0")
    .join(":")}::/64`;
}

/**
 * Read the request body with a hard cap. Returns null when it's too large (→ 413).
 *
 * DO NOT reintroduce `reader.cancel()` here. Cancelling an INCOMING request body while the client is
 * still sending resets the connection, and workerd surfaces that as an uncaught "Network connection
 * lost" that tears down the Durable Object — so one oversized request (which anyone who knows a
 * sandbox URL can send, unauthenticated) permanently killed that session's live stream and started
 * 503ing its ingest. Instead: reject a declared over-cap length before touching the body at all, and
 * otherwise stop accumulating and let the runtime tear the stream down with the response.
 */
async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  // Fast path: an honest Content-Length over the cap is refused without reading a single byte.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) return null; // chunked/undeclared body that lied about its size
      chunks.push(value);
    }
  } catch {
    // A client that hangs up mid-body is not our problem — and must never become the DO's problem.
    return null;
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Verify a Turnstile token. Off in dev/tests. The only outbound fetch, to a fixed URL. */
async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  if (env.TURNSTILE_MODE !== "on") return true;
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("remoteip", ip);
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY, { method: "POST", body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * The origin we ADVERTISE in the ingest URL and curl snippet — it must be a URL the user can actually
 * call. Hardcoding `https` handed a `wrangler dev` user `https://localhost:8799/...`, which dies with
 * ERR_SSL_PROTOCOL_ERROR. Only LOOPBACK may follow the request's real scheme; every other host is
 * forced to https, so a plaintext request to prod can never make us advertise a plaintext ingest URL.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function advertisedOrigin(url: URL): string {
  const scheme = LOOPBACK_HOSTS.has(url.hostname) ? url.protocol.replace(":", "") : "https";
  return `${scheme}://${url.host}`;
}

/**
 * The two endpoints a BROWSER calls cross-origin, and therefore the only paths where an OPTIONS is a
 * CORS preflight. Everywhere else OPTIONS is just another verb to capture — live ingest (wbhk.my)
 * accepts every verb, and the sandbox must not teach a behaviour the product doesn't have.
 */
function isBrowserEndpoint(path: string): boolean {
  return path === "/api/mint" || /^\/[0-9a-f]{32}\/stream$/.test(path);
}

/** Read the per-token viewer-secret cookie (`pv_<token>`) from the request. */
function viewerCookie(request: Request, token: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === `pv_${token}`) return v.join("=");
  }
  return null;
}

async function handleMint(request: Request, env: Env, url: URL, origin: string): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  let turnstileToken: string | undefined;
  try {
    const body = (await request.json()) as { turnstileToken?: string };
    turnstileToken = body?.turnstileToken;
  } catch {
    /* empty/invalid body is fine when Turnstile is off */
  }
  if (!(await verifyTurnstile(env, turnstileToken, ip))) {
    return json({ error: "challenge_failed" }, 403, corsHeaders(origin));
  }

  const token = newIngestToken();
  const viewerSecret = newViewerSecret();
  const now = Date.now();
  const ttlMs = Number(env.PLAY_TTL_MS) || 900_000;
  const expiresAt = now + ttlMs;

  const coordinator = env.PLAY_COORDINATOR.get(env.PLAY_COORDINATOR.idFromName("global"));
  const reserved = await coordinator.reserve({
    token,
    ipBucket: ipBucket(ip),
    expiresAt,
    now,
    maxActive: Number(env.PLAY_MAX_ACTIVE) || 5000,
    maxPerIp: Number(env.PLAY_MAX_PER_IP) || 5,
  });
  if (!reserved.ok) {
    return json({ error: "rate_limited", reason: reserved.reason }, 429, corsHeaders(origin));
  }

  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  await session.init({ viewerSecret, mintedAt: now, ttlMs });

  const ingestUrl = `${advertisedOrigin(url)}/${token}`;
  // The viewer secret rides in an HttpOnly cookie scoped to this token's stream path — NOT in the
  // response body and NOT in any URL, so it never lands in a request log or in page JS. The browser
  // sends it automatically on the EventSource (withCredentials). SameSite=None+Secure because the www
  // page and the play worker are different registrable sites.
  const cookie = `pv_${token}=${viewerSecret}; HttpOnly; Secure; SameSite=None; Path=/${token}/stream; Max-Age=${Math.ceil(ttlMs / 1000)}`;
  return json(
    {
      token,
      ingestUrl,
      expiresAt,
      curl: `curl -X POST ${ingestUrl} -H 'content-type: application/json' -d '{"hello":"webhook.co"}'`,
      // Every verb is captured (same posture as live ingest), so a plain browser GET works too — the
      // easiest possible first request for someone who doesn't want to open a terminal.
      browseUrl: ingestUrl,
    },
    200,
    { ...corsHeaders(origin), "set-cookie": cookie },
  );
}

async function handleIngest(request: Request, env: Env, token: string): Promise<Response> {
  const raw = await readCapped(request, INGEST_MAX_BYTES);
  if (raw === null) return text("payload too large", 413);

  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  const result = await session.capture({
    method: request.method,
    headers: [...request.headers],
    bodyBytes: raw,
    now: Date.now(),
  });
  if (result.reason === "uninitialized") return text("not found", 404);
  if (result.reason === "expired") return text("this sandbox url has expired", 410);
  if (result.reason === "cap") return text("capture limit reached", 429);
  return text("captured — watch it in the browser tab that made this url\n", 200);
}

async function handleStream(
  request: Request,
  env: Env,
  token: string,
  origin: string,
): Promise<Response> {
  // Session-bound: the viewer secret comes from the HttpOnly cookie, never the URL. Pass it to the DO
  // via an internal header so it stays out of any request-URL log.
  const secret = viewerCookie(request, token);
  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  const doReq = new Request(request.url, {
    headers: { "x-play-viewer": secret ?? "", accept: "text/event-stream" },
    signal: request.signal,
  });
  const res = await session.fetch(doReq);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...corsHeaders(origin), ...SECURITY_HEADERS })) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = allowedOrigin(env, request);

    // Only a preflight on the two browser-called endpoints. An OPTIONS to a bare token path is a
    // captured request like any other verb — see isBrowserEndpoint.
    if (request.method === "OPTIONS" && isBrowserEndpoint(path)) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (path === "/healthz") return text("ok", 200);
    if (path === "/") return Response.redirect(`${WWW_ORIGIN}/play`, 302);
    if (path === "/api/mint" && request.method === "POST") {
      return handleMint(request, env, url, origin);
    }

    const segments = path.replace(/^\/+/, "").split("/");
    const token = segments[0] ?? "";
    if (!TOKEN_RE.test(token)) return text("not found", 404);
    if (segments[1] === "stream" && request.method === "GET") {
      return handleStream(request, env, token, origin);
    }
    if (segments.length === 1) return handleIngest(request, env, token);
    return text("not found", 404);
  },
} satisfies ExportedHandler<Env>;
