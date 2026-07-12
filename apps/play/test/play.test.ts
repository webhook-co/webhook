import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// End-to-end through the real Workers runtime (workerd): mint → capture → session-bound stream (via
// the HttpOnly viewer cookie) → caps → absolute-TTL self-destruct → per-IP (/64) mint budget → body
// cap. These are the security controls, exercised against the actual DO/alarm behaviour, not a mock.

const HOST = "https://play.wbhk.my";

async function mint(ip = "203.0.113.1") {
  return SELF.fetch(`${HOST}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({}),
  });
}

/** Extract the per-token viewer cookie (pv_<token>=<secret>) from a mint response's Set-Cookie. */
function cookieFor(res: Response, token: string): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(new RegExp(`pv_${token}=([0-9a-f]+)`));
  return m ? `pv_${token}=${m[1]}` : "";
}

/** Read one SSE stream's replay (with the viewer cookie), then cancel. Never blocks the test. */
async function readReplay(token: string, cookie: string): Promise<string> {
  const res = await SELF.fetch(`${HOST}/${token}/stream`, { headers: { cookie } });
  if (res.status !== 200 || !res.body) return `status:${res.status}`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  const timeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 500))]);
  // Enough reads to drain a multi-record replay (the all-verbs test alone replays seven records).
  for (let i = 0; i < 24; i++) {
    const chunk = (await timeout(reader.read())) as { value?: Uint8Array; done: boolean };
    if (chunk.done) break;
    if (chunk.value) out += dec.decode(chunk.value);
    if (out.includes(": expires")) break;
  }
  await reader.cancel().catch(() => {});
  return out;
}

describe("/play worker", () => {
  it("mints a token + ingest URL + expiry, and sets the viewer secret in an HttpOnly cookie (not the body)", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.ingestUrl).toBe(`${HOST}/${body.token}`);
    expect(typeof body.expiresAt).toBe("number");
    // The secret is NOT in the response body — it rides in an HttpOnly, Secure cookie.
    expect(body.viewerSecret).toBeUndefined();
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`pv_${body.token}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=None");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.webhook.co");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("captures a request and streams it ONLY to a holder of the viewer cookie", async () => {
    const res = await mint();
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);
    expect(cookie).toContain(`pv_${token}=`);

    const ingest = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    expect(ingest.status).toBe(200);

    // No cookie / wrong cookie → 403 (a bare token URL cannot read the stream).
    expect((await SELF.fetch(`${HOST}/${token}/stream`)).status).toBe(403);
    expect(
      (
        await SELF.fetch(`${HOST}/${token}/stream`, {
          headers: { cookie: `pv_${token}=${"0".repeat(32)}` },
        })
      ).status,
    ).toBe(403);

    // Correct cookie → the capture replays.
    const replay = await readReplay(token, cookie);
    expect(replay).toContain("data: ");
    const frame = replay.split("\n").find((l) => l.startsWith("data: "))!;
    const record = JSON.parse(frame.slice("data: ".length));
    expect(record.method).toBe("POST");
    expect(record.body).toBe('{"hello":"world"}');
  });

  it("enforces the per-token capture cap (and accepts the ones under it — non-vacuous)", async () => {
    const { token } = (await (await mint()).json()) as { token: string };
    const first = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "0" });
    expect(first.status).toBe(200); // proves the cap isn't just rejecting everything
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      last = (await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: `${i}` })).status;
    }
    expect(last).toBe(429); // the 101st is refused
  });

  it("413s a body over the cap without buffering it whole (streamed guard)", async () => {
    const { token } = (await (await mint()).json()) as { token: string };
    const big = "x".repeat(64 * 1024 + 1024); // > 64KB cap
    const res = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: big });
    expect(res.status).toBe(413);
  });

  it("self-destructs on the absolute-TTL alarm: captures gone, further posts 410, stream 403", async () => {
    const res = await mint();
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);
    await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "before" });

    const stub = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
    await runDurableObjectAlarm(stub);

    const post = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "after" });
    expect([404, 410]).toContain(post.status);
    expect((await SELF.fetch(`${HOST}/${token}/stream`, { headers: { cookie } })).status).toBe(403);
  });

  it("caps concurrent tokens per IP, and per IPv6 /64 (a single /64 can't evade it)", async () => {
    // 6th mint from one IPv4 is refused (first succeeds — non-vacuous).
    const ip4 = "198.51.100.7";
    expect((await mint(ip4)).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await mint(ip4)).status;
    expect(last).toBe(429);

    // Two different addresses in the SAME /64 share the budget → the 6th across them is refused.
    let last6 = 0;
    for (let i = 0; i < 6; i++) {
      const addr = i % 2 === 0 ? "2001:db8:1:1::1" : "2001:db8:1:1::2"; // same /64
      last6 = (await mint(addr)).status;
    }
    expect(last6).toBe(429);
  });

  it("404s a non-token path and redirects root to the marketing /play", async () => {
    expect((await SELF.fetch(`${HOST}/not-a-token`)).status).toBe(404);
    const root = await SELF.fetch(`${HOST}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://www.webhook.co/play");
  });
});

// An oversized body — which anyone who knows a sandbox URL can send, unauthenticated — used to leave
// that session's SSE stream permanently dead and its ingest 503ing: `readCapped` called
// `reader.cancel()` on the in-flight request body, workerd raised an uncaught "Network connection
// lost", and the Durable Object was torn down. Captures kept landing; the owner could no longer watch.
//
// ⚠️ HONESTY ABOUT THESE TESTS: they pin the OBSERVABLE contract (413 on both the declared and the
// streamed path; ingest and stream both survive it) — but they do NOT reproduce the wedge itself.
// Mutation-checked: they pass against the buggy `reader.cancel()` code too, because `SELF.fetch` has
// no real socket to reset. The invariant is genuinely guarded in two other places, both of which DO
// fail on the old code: `scripts/check-no-body-cancel.mjs` (static, runs in the gate) and
// `scripts/drive-local.sh` (real HTTP against `wrangler dev`). Do not mistake this block for the guard.
describe("/play — an oversized request must not blind the viewer", () => {
  it("keeps the stream alive and replaying after a 413", async () => {
    const res = await mint("203.0.113.30");
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);

    await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "before" });
    const tooBig = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      body: "A".repeat(70_000),
    });
    expect(tooBig.status).toBe(413);

    // The sandbox still accepts traffic…
    const after = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "after" });
    expect(after.status).toBe(200);
    // …and the owner can still SEE it — both the capture from before the 413 and the one after.
    const replay = await readReplay(token, cookie);
    expect(replay).toContain("before");
    expect(replay).toContain("after");
  });

  it("survives a STREAMED over-cap body that lies about its length (no content-length fast path)", async () => {
    const res = await mint("203.0.113.31");
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);
    await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "before" });

    // A chunked body drip-fed from a stream: no Content-Length, so the cap can only be discovered
    // mid-read — the exact path where the old code called reader.cancel() and killed the DO.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++)
          controller.enqueue(new TextEncoder().encode("A".repeat(10_000)));
        controller.close();
      },
    });
    const tooBig = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(tooBig.status).toBe(413);

    const after = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "after" });
    expect(after.status).toBe(200);
    const replay = await readReplay(token, cookie);
    expect(replay).toContain("before");
    expect(replay).toContain("after");
  });

  it("refuses an over-cap Content-Length without reading the body at all", async () => {
    const res = await mint("203.0.113.32");
    const { token } = (await res.json()) as { token: string };
    // The declared length alone is disqualifying — we never touch the stream, so there is nothing to
    // cancel and no connection to reset.
    const tooBig = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      headers: { "content-length": "70000" },
      body: "A".repeat(70_000),
    });
    expect(tooBig.status).toBe(413);
    expect((await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "x" })).status).toBe(200);
  });
});

// The URL we hand the user has to be one they can actually call. It was hardcoded to `https://`, which
// is right in prod but hands a `wrangler dev` user an https://localhost URL that dies with
// ERR_SSL_PROTOCOL_ERROR. Scheme now follows the host — but ONLY loopback may relax to http, so prod
// can never advertise a plaintext ingest URL even if a plaintext request somehow reaches the worker.
describe("/play — the advertised ingest URL is callable", () => {
  async function mintAt(host: string) {
    const res = await SELF.fetch(`${host}/api/mint`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({}),
    });
    return (await res.json()) as { token: string; ingestUrl: string };
  }

  it("advertises https for a real host", async () => {
    const body = await mintAt(HOST);
    expect(body.ingestUrl).toBe(`https://play.wbhk.my/${body.token}`);
  });

  it("advertises http for loopback so a local wrangler dev URL is actually reachable", async () => {
    for (const host of ["http://localhost:8799", "http://127.0.0.1:8799"]) {
      const body = await mintAt(host);
      expect(body.ingestUrl.startsWith(`${host}/`)).toBe(true);
      expect(body.ingestUrl).not.toContain("https://localhost");
      expect(body.ingestUrl).not.toContain("https://127.0.0.1");
    }
  });

  it("NEVER advertises plaintext for a non-loopback host, even on a plaintext request", async () => {
    const body = await mintAt("http://play.wbhk.my");
    expect(body.ingestUrl).toBe(`https://play.wbhk.my/${body.token}`);
  });
});

// Live ingest (wbhk.my) accepts every verb — /play must match, or the sandbox teaches a behaviour the
// product doesn't have. OPTIONS was the one gap: the global CORS-preflight branch swallowed it before
// it could reach ingest. Preflight is now scoped to the two endpoints a BROWSER actually calls.
describe("/play — accepts all verbs, like live ingest", () => {
  it("captures every verb, including OPTIONS, on a bare token path", async () => {
    const res = await mint("203.0.113.20");
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      const r = await SELF.fetch(`${HOST}/${token}`, {
        method,
        ...(method === "GET" || method === "HEAD" ? {} : { body: `via-${method}` }),
      });
      expect(r.status, `${method} should be captured`).toBe(200);
    }

    // …and every one of them actually landed in the session, not just returned 200.
    const replay = await readReplay(token, cookie);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      expect(replay, `${method} should appear in the stream`).toContain(`"${method}"`);
    }
  });

  it("lets a BROWSER fetch() a sandbox url: the token path answers its own preflight", async () => {
    // Found in security review: scoping the preflight meant a devtools
    // `fetch(url, {method:'POST', headers:{'content-type':'application/json'}})` — a preflighted
    // request — would fail. Ingest is open-CORS so poking a sandbox from the console works, while the
    // OPTIONS itself is still captured like every other verb.
    const res = await mint("203.0.113.40");
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieFor(res, token);

    const pre = await SELF.fetch(`${HOST}/${token}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toBe("*");

    const post = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: '{"from":"devtools"}',
    });
    expect(post.headers.get("access-control-allow-origin")).toBe("*");
    expect(await readReplay(token, cookie)).toContain("devtools");
  });

  it("open CORS on ingest does NOT extend to the stream — a sandbox is writable, never readable", async () => {
    // The asymmetry is the whole security model: anyone can WRITE to a token they know (a form POST
    // never needed CORS anyway), but READING the captures stays pinned to the www origin, with
    // credentials, behind the HttpOnly viewer cookie.
    const res = await mint("203.0.113.41");
    const { token } = (await res.json()) as { token: string };
    const stream = await SELF.fetch(`${HOST}/${token}/stream`, {
      headers: { origin: "https://example.com", cookie: cookieFor(res, token) },
    });
    expect(stream.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("still answers a real CORS preflight on /api/mint (the browser needs it)", async () => {
    const res = await SELF.fetch(`${HOST}/api/mint`, {
      method: "OPTIONS",
      headers: { origin: "https://www.webhook.co" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("still answers a real CORS preflight on the stream path", async () => {
    const res = await SELF.fetch(`${HOST}/${"a".repeat(32)}/stream`, {
      method: "OPTIONS",
      headers: { origin: "https://www.webhook.co" },
    });
    expect(res.status).toBe(204);
  });
});
