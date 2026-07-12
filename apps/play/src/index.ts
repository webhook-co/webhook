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
/** Hard request-size guard before we read the body into memory (storage is capped smaller still). */
const INGEST_MAX_BYTES = 256 * 1024;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": WWW_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-robots-tag": "noindex", ...extra },
  });
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

async function handleMint(request: Request, env: Env, url: URL): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  let turnstileToken: string | undefined;
  try {
    const body = (await request.json()) as { turnstileToken?: string };
    turnstileToken = body?.turnstileToken;
  } catch {
    /* empty/invalid body is fine when Turnstile is off */
  }
  if (!(await verifyTurnstile(env, turnstileToken, ip))) {
    return json({ error: "challenge_failed" }, 403, corsHeaders());
  }

  const token = newIngestToken();
  const viewerSecret = newViewerSecret();
  const now = Date.now();
  const ttlMs = Number(env.PLAY_TTL_MS) || 900_000;
  const expiresAt = now + ttlMs;

  const coordinator = env.PLAY_COORDINATOR.get(env.PLAY_COORDINATOR.idFromName("global"));
  const reserved = await coordinator.reserve({
    token,
    ip,
    expiresAt,
    now,
    maxActive: Number(env.PLAY_MAX_ACTIVE) || 5000,
    maxPerIp: Number(env.PLAY_MAX_PER_IP) || 5,
  });
  if (!reserved.ok) {
    return json({ error: "rate_limited", reason: reserved.reason }, 429, corsHeaders());
  }

  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  await session.init({ viewerSecret, ip, mintedAt: now, ttlMs });

  const ingestUrl = `https://${url.host}/${token}`;
  return json(
    {
      token,
      viewerSecret, // held by the minting browser only; required to open the stream
      ingestUrl,
      expiresAt,
      curl: `curl -X POST ${ingestUrl} -H 'content-type: application/json' -d '{"hello":"webhook.co"}'`,
    },
    200,
    corsHeaders(),
  );
}

async function handleIngest(request: Request, env: Env, token: string): Promise<Response> {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > INGEST_MAX_BYTES) {
    return new Response("payload too large", {
      status: 413,
      headers: { "x-robots-tag": "noindex" },
    });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > INGEST_MAX_BYTES) {
    return new Response("payload too large", {
      status: 413,
      headers: { "x-robots-tag": "noindex" },
    });
  }
  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  const result = await session.capture({
    method: request.method,
    headers: [...request.headers],
    bodyBytes: raw,
    now: Date.now(),
  });
  const noindex = { "x-robots-tag": "noindex", "content-type": "text/plain" };
  if (result.reason === "uninitialized")
    return new Response("not found", { status: 404, headers: noindex });
  if (result.reason === "expired")
    return new Response("this sandbox url has expired", { status: 410, headers: noindex });
  if (result.reason === "cap")
    return new Response("capture limit reached", { status: 429, headers: noindex });
  return new Response("captured — watch it in the browser tab that made this url\n", {
    status: 200,
    headers: noindex,
  });
}

async function handleStream(request: Request, env: Env, token: string): Promise<Response> {
  const session = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
  const res = await session.fetch(request); // DO validates the ?v= viewer secret (session-bound)
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders() });
    if (path === "/healthz") return new Response("ok", { status: 200 });
    if (path === "/") return Response.redirect(`${WWW_ORIGIN}/play`, 302);
    if (path === "/api/mint" && request.method === "POST") return handleMint(request, env, url);

    const segments = path.replace(/^\/+/, "").split("/");
    const token = segments[0] ?? "";
    if (!TOKEN_RE.test(token)) {
      return new Response("not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
    }
    if (segments[1] === "stream" && request.method === "GET")
      return handleStream(request, env, token);
    if (segments.length === 1) return handleIngest(request, env, token);
    return new Response("not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  },
} satisfies ExportedHandler<Env>;
