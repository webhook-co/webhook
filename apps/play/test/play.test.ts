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
  for (let i = 0; i < 6; i++) {
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
