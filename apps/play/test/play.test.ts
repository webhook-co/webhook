import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// End-to-end through the real Workers runtime (workerd): mint → capture → session-bound stream →
// caps → absolute-TTL self-destruct → per-IP mint budget. These are the security controls, so they
// are exercised against the actual DO/alarm behaviour, not a mock.

const HOST = "https://play.wbhk.my";

async function mint(ip = "203.0.113.1") {
  const res = await SELF.fetch(`${HOST}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({}),
  });
  return res;
}

/** Read one SSE stream's currently-available frames (replay), then cancel. Never blocks the test. */
async function readReplay(streamUrl: string): Promise<string> {
  const res = await SELF.fetch(streamUrl);
  if (res.status !== 200 || !res.body) return `status:${res.status}`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  // The DO writes replayed captures + a keepalive comment (": expires …") on connect, then idles.
  // Read until the keepalive arrives, but never block the test: race each read against a short timer.
  const timeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 750))]);
  for (let i = 0; i < 8; i++) {
    const chunk = (await timeout(reader.read())) as { value?: Uint8Array; done: boolean };
    if (chunk.done) break;
    if (chunk.value) out += dec.decode(chunk.value);
    if (out.includes(": expires")) break; // keepalive marks the end of replay
  }
  await reader.cancel().catch(() => {});
  return out;
}

describe("/play worker", () => {
  it("mints a token, viewer secret, ingest URL and expiry", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.viewerSecret).toMatch(/^[0-9a-f]{32}$/);
    expect(body.ingestUrl).toBe(`${HOST}/${body.token}`);
    expect(typeof body.expiresAt).toBe("number");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.webhook.co");
  });

  it("captures a request and streams it ONLY to a holder of the viewer secret", async () => {
    const { token, viewerSecret } = (await (await mint()).json()) as {
      token: string;
      viewerSecret: string;
    };

    const ingest = await SELF.fetch(`${HOST}/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    expect(ingest.status).toBe(200);

    // Wrong / missing secret → 403 (a bare shared URL cannot read the stream).
    expect((await SELF.fetch(`${HOST}/${token}/stream`)).status).toBe(403);
    expect((await SELF.fetch(`${HOST}/${token}/stream?v=deadbeef`)).status).toBe(403);

    // Correct secret → the capture replays. The body is a JSON string value in the frame, so its
    // quotes are escaped — assert the parsed record rather than a brittle substring.
    const replay = await readReplay(`${HOST}/${token}/stream?v=${viewerSecret}`);
    expect(replay).toContain("data: ");
    const frame = replay.split("\n").find((l) => l.startsWith("data: "))!;
    const record = JSON.parse(frame.slice("data: ".length));
    expect(record.method).toBe("POST");
    expect(record.body).toBe('{"hello":"world"}');
  });

  // NOTE: the SSE-framing XSS-safety (an attacker body survives only as escaped JSON on one data
  // line, never a second frame) is asserted directly and deterministically in src/core.test.ts
  // ("sseFrame — XSS/stream-spoof safety"); the no-EXECUTION property belongs at the render layer and
  // is covered by a Playwright test on the /play page (inert React text nodes).

  it("enforces the per-token capture cap", async () => {
    const { token } = (await (await mint()).json()) as { token: string };
    let last = 0;
    for (let i = 0; i < 101; i++) {
      last = (await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: `${i}` })).status;
    }
    expect(last).toBe(429); // the 101st is refused
  });

  it("self-destructs on the absolute-TTL alarm: captures gone, further posts 410", async () => {
    const { token, viewerSecret } = (await (await mint()).json()) as {
      token: string;
      viewerSecret: string;
    };
    await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "before" });

    // Fire the DO's self-destruct alarm directly (simulates the absolute TTL elapsing).
    const stub = env.PLAY_SESSION.get(env.PLAY_SESSION.idFromName(token));
    await runDurableObjectAlarm(stub);

    // Everything is gone: the session no longer exists → posting is 410 (expired) or 404, and the
    // stream no longer authenticates.
    const post = await SELF.fetch(`${HOST}/${token}`, { method: "POST", body: "after" });
    expect([404, 410]).toContain(post.status);
    expect((await SELF.fetch(`${HOST}/${token}/stream?v=${viewerSecret}`)).status).toBe(403);
  });

  it("caps concurrent tokens per IP (mint circuit-breaker)", async () => {
    const ip = "198.51.100.7";
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await mint(ip)).status;
    expect(last).toBe(429); // 6th mint from one IP is rate-limited (PLAY_MAX_PER_IP=5)
  });

  it("404s a non-token path and redirects root to the marketing /play", async () => {
    expect((await SELF.fetch(`${HOST}/not-a-token`)).status).toBe(404);
    const root = await SELF.fetch(`${HOST}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://www.webhook.co/play");
  });
});
