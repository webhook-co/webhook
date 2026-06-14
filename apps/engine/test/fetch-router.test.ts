import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleFetch, type Env, type IngestDepsHandle } from "../src/index";
import type { IngestDeps, ResolvedEndpoint } from "../src/ingest";

// The wbhk.my fetch router: GET / is the only liveness probe; everything else is the cookieless,
// path-token ingest path. The router owns per-request DB-client lifecycle (close() in a finally),
// so the resolver/insert deps are built per request and torn down even on a thrown error. Deps are
// injected here (a fake makeDeps) so routing + lifecycle are tested without a live Postgres — the
// handleIngest orchestration and insertIngestEvent are covered by their own suites.
const bindings = env as unknown as Env;

function fakeHandle(over: Partial<IngestDeps> = {}): {
  handle: IngestDepsHandle;
  closed: () => number;
} {
  let closes = 0;
  const deps: IngestDeps = {
    resolve: async (token): Promise<ResolvedEndpoint | null> =>
      token === "whep_good" ? { orgId: "o", endpointId: "e", paused: false } : null,
    putPayload: async () => undefined,
    ingestEvent: async () => ({ inserted: true }),
    now: () => new Date("2026-06-14T12:00:00Z"),
    log: () => undefined,
    maxBodyBytes: 1024 * 1024,
    dedupBucketWidthMs: 24 * 60 * 60 * 1000,
    ...over,
  };
  return {
    handle: {
      deps,
      close: async () => {
        closes += 1;
      },
    },
    closed: () => closes,
  };
}

function get(path: string): Request {
  return new Request(`https://wbhk.my${path}`, { method: "GET" });
}
function post(path: string, body = `{"hello":"world"}`): Request {
  return new Request(`https://wbhk.my${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("handleFetch routing + lifecycle", () => {
  it("GET / is the liveness probe (200), and does NOT build ingest deps", async () => {
    let built = 0;
    const res = await handleFetch(get("/"), bindings, () => {
      built += 1;
      return fakeHandle().handle;
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("webhook:engine ok");
    expect(built).toBe(0); // health never touches the DB path
  });

  it("routes a POST token path to ingest and closes the deps afterward", async () => {
    const f = fakeHandle();
    const res = await handleFetch(post("/whep_good"), bindings, () => f.handle);
    expect(res.status).toBe(200);
    expect(f.closed()).toBe(1); // per-request clients torn down
  });

  it("an unknown token still routes to ingest (404), and deps are closed", async () => {
    const f = fakeHandle();
    const res = await handleFetch(post("/whep_nope"), bindings, () => f.handle);
    expect(res.status).toBe(404);
    expect(f.closed()).toBe(1);
  });

  it("a GET on a token path is NOT the health probe — it routes to ingest (405)", async () => {
    const f = fakeHandle();
    const res = await handleFetch(get("/whep_good"), bindings, () => f.handle);
    expect(res.status).toBe(405); // ingest rejects non-POST; only GET / is health
    expect(f.closed()).toBe(1);
  });

  it("if the handler throws, the router returns 500 and STILL closes the deps (finally)", async () => {
    const f = fakeHandle({
      resolve: async () => {
        throw new Error("hyperdrive down");
      },
    });
    const res = await handleFetch(post("/whep_good"), bindings, () => f.handle);
    expect(res.status).toBe(500);
    expect(f.closed()).toBe(1); // no leaked DB connections on the error path
  });
});
