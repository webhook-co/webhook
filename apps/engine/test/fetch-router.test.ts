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
// A no-op ExecutionContext: the fake ingest deps here carry no autoDeliver, so waitUntil is never invoked;
// it only satisfies handleFetch's signature (production wires deps.waitUntil to ctx.waitUntil).
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function fakeHandle(over: Partial<IngestDeps> = {}): {
  handle: IngestDepsHandle;
  closed: () => number;
} {
  let closes = 0;
  const deps: IngestDeps = {
    resolve: async (token): Promise<ResolvedEndpoint | null> =>
      token === "whep_good"
        ? { orgId: "o", endpointId: "e", paused: false, sealedSecrets: [] }
        : null,
    verify: async () => ({ verified: false, verification: null }),
    putPayload: async () => undefined,
    ingestEvent: async () => ({ inserted: true }),
    now: () => new Date("2026-06-14T12:00:00Z"),
    log: () => undefined,
    maxBodyBytes: 1024 * 1024,
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
function httpGet(path: string): Request {
  return new Request(`http://wbhk.my${path}`, { method: "GET" });
}
function httpPost(path: string, body = `{"hello":"world"}`): Request {
  return new Request(`http://wbhk.my${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("handleFetch cleartext refusal (S6a — the DPA's TLS-everywhere promise)", () => {
  it("301-redirects a plaintext ingest POST to https BEFORE resolving the token or building deps", async () => {
    // The ingest token rides in the URL PATH, so a cleartext request already exposed it. Refuse it: 301 to
    // the https equivalent (the version-controlled backstop to the zone's Always-Use-HTTPS). The redirect
    // must precede token resolution/capture — a plaintext event must never be captured (a DPA breach).
    let built = 0;
    const res = await handleFetch(httpPost("/whep_good"), bindings, ctx, () => {
      built += 1;
      return Promise.resolve(fakeHandle().handle);
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://wbhk.my/whep_good");
    expect(built).toBe(0); // never resolved the token, never captured over cleartext
  });

  it("301s plaintext BEFORE /healthz and BEFORE the bare-root 302 (every wbhk.my surface is https-only)", async () => {
    const health = await handleFetch(httpGet("/healthz"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(health.status).toBe(301);
    expect(health.headers.get("location")).toBe("https://wbhk.my/healthz");

    const root = await handleFetch(httpGet("/"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(root.status).toBe(301); // the http→https 301 wins over the root's https 302
    expect(root.headers.get("location")).toBe("https://wbhk.my/");
  });

  it("preserves the path AND query string in the https redirect", async () => {
    const res = await handleFetch(httpGet("/whep_good?a=1&b=2"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://wbhk.my/whep_good?a=1&b=2");
  });

  it("serves HSTS on the https liveness surfaces (so a browser auto-upgrades future requests)", async () => {
    const health = await handleFetch(get("/healthz"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(health.headers.get("strict-transport-security")).toBe("max-age=63072000");
    const root = await handleFetch(get("/"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(root.headers.get("strict-transport-security")).toBe("max-age=63072000");
  });

  it("serves HSTS on the plain() ingest responses too (the capture ACK and the unknown-token 404)", async () => {
    // /healthz + / above go through `new Response(...)` with LIVENESS_HEADERS; these go through plain()'s
    // OWN base headers instead — so this is the assertion that actually guards the HSTS line in plain().
    const ack = await handleFetch(post("/whep_good"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(ack.status).toBe(200); // captured
    expect(ack.headers.get("strict-transport-security")).toBe("max-age=63072000");

    const notFound = await handleFetch(post("/whep_nope"), bindings, ctx, () =>
      Promise.resolve(fakeHandle().handle),
    );
    expect(notFound.status).toBe(404); // unknown token
    expect(notFound.headers.get("strict-transport-security")).toBe("max-age=63072000");
  });

  it("refuses cleartext for ALL verbs (a non-ingest verb over http is 301'd BEFORE the method gate) + HSTS on the 301", async () => {
    // The http check is hoisted above the method gate, so even an unsupported verb over http gets the 301,
    // never the 405 — locking in "cleartext refusal precedes method handling".
    const put = await handleFetch(
      new Request("http://wbhk.my/whep_good", { method: "PUT" }),
      bindings,
      ctx,
      () => Promise.resolve(fakeHandle().handle),
    );
    expect(put.status).toBe(301);
    expect(put.headers.get("location")).toBe("https://wbhk.my/whep_good");
    expect(put.headers.get("strict-transport-security")).toBe("max-age=63072000");

    const trace = await handleFetch(
      new Request("http://wbhk.my/x", { method: "TRACE" }),
      bindings,
      ctx,
      () => Promise.resolve(fakeHandle().handle),
    );
    expect(trace.status).toBe(301); // NOT the 405 the method gate would give over https
  });
});

describe("handleFetch routing + lifecycle", () => {
  it("GET / 302-redirects to the marketing homepage, and does NOT build ingest deps", async () => {
    let built = 0;
    const res = await handleFetch(get("/"), bindings, ctx, () => {
      built += 1;
      return Promise.resolve(fakeHandle().handle);
    });
    expect(res.status).toBe(302); // temporary/reversible bounce to www.webhook.co (not the old 200 probe)
    expect(res.headers.get("location")).toBe("https://www.webhook.co/");
    expect(res.headers.get("x-robots-tag")).toBe("noindex"); // keep the ingest apex out of search indexes
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(built).toBe(0); // the bounce never touches the DB path
  });

  it("GET /healthz is a 200 liveness probe, and does NOT build ingest deps", async () => {
    let built = 0;
    const res = await handleFetch(get("/healthz"), bindings, ctx, () => {
      built += 1;
      return Promise.resolve(fakeHandle().handle);
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(built).toBe(0); // health never touches the DB path
  });

  it("a token path is NEVER caught by the root redirect — GET/POST /whep_good route to ingest (no 3xx)", async () => {
    // The isolation guard: the bare-root bounce must not swallow ingest. A token path is resolved by the
    // ingest write path, never redirected — so it carries no Location and is not a 3xx.
    for (const req of [get("/whep_good"), post("/whep_good")]) {
      const f = fakeHandle();
      const res = await handleFetch(req, bindings, ctx, () => Promise.resolve(f.handle));
      expect(res.status, req.method).toBe(200); // routed to ingest (known token → captured)
      expect(res.status, req.method).toBeLessThan(300); // definitively not a redirect
      expect(res.headers.get("location"), req.method).toBeNull();
      expect(f.closed(), req.method).toBe(1);
    }
  });

  it("routes a POST token path to ingest and closes the deps afterward", async () => {
    const f = fakeHandle();
    const res = await handleFetch(post("/whep_good"), bindings, ctx, () =>
      Promise.resolve(f.handle),
    );
    expect(res.status).toBe(200);
    expect(f.closed()).toBe(1); // per-request clients torn down
  });

  it("an unknown but WELL-FORMED token still routes to ingest (404), and deps are closed", async () => {
    const f = fakeHandle();
    const res = await handleFetch(post("/whep_nope"), bindings, ctx, () =>
      Promise.resolve(f.handle),
    );
    expect(res.status).toBe(404);
    expect(f.closed()).toBe(1);
  });

  it("a path that can't be a token (scanner junk) is a fast 404 WITHOUT building ingest deps (no cold lookup)", async () => {
    // These are real vuln-scanner probes seen in prod. None sit in the `whep_` token namespace, so they
    // must 404 before any DB pool / cold lookup opens — otherwise a scanner burst pounds the metered
    // cold-lookup path and surfaces as transient 500s / worker hangs when the connection drops.
    for (const junk of [
      "/config.js",
      "/application.yml",
      "/app/config/parameters.yml",
      "/terraform.tfstate",
      "/.env",
      "/wp-login.php",
    ]) {
      let built = 0;
      const res = await handleFetch(post(junk), bindings, ctx, () => {
        built += 1;
        return Promise.resolve(fakeHandle().handle);
      });
      expect(res.status, junk).toBe(404);
      expect(res.headers.get("x-content-type-options"), junk).toBe("nosniff"); // same no-oracle shape
      expect(built, junk).toBe(0); // never touched the DB path
    }
  });

  it("the bare apex (no token) is a 404 without building deps", async () => {
    let built = 0;
    const res = await handleFetch(post("/"), bindings, ctx, () => {
      built += 1;
      return Promise.resolve(fakeHandle().handle);
    });
    expect(res.status).toBe(404);
    expect(built).toBe(0);
  });

  it("an unsupported verb gets a UNIFORM 405 + Allow — on a junk path AND a real token (no oracle)", async () => {
    // The verb gate runs BEFORE the token pre-filter, so a non-standard method is answered identically
    // whether or not the path looks like a token — preserving the no-token-validity-leak property.
    for (const path of ["/.env", "/whep_good"]) {
      let built = 0;
      const req = new Request(`https://wbhk.my${path}`, { method: "PROPFIND" });
      const res = await handleFetch(req, bindings, ctx, () => {
        built += 1;
        return Promise.resolve(fakeHandle().handle);
      });
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE");
      expect(built, path).toBe(0); // rejected before any DB pool opens
    }
  });

  it("a GET on a token path is the per-token ingest liveness (200), not the bare-apex bounce", async () => {
    const f = fakeHandle();
    const res = await handleFetch(get("/whep_good"), bindings, ctx, () =>
      Promise.resolve(f.handle),
    );
    expect(res.status).toBe(200); // accept-all-verbs: a token-path GET is captured + answered with liveness
    const body = await res.text();
    expect(body).toMatch(/live/i); // the per-token ingest liveness (its own body, distinct from GET /)
    expect(res.headers.get("location")).toBeNull(); // …never the bare-apex redirect
    expect(f.closed()).toBe(1);
  });

  it("if the handler throws, the router returns 500 and STILL closes the deps (finally)", async () => {
    const f = fakeHandle({
      resolve: async () => {
        throw new Error("hyperdrive down");
      },
    });
    const res = await handleFetch(post("/whep_good"), bindings, ctx, () =>
      Promise.resolve(f.handle),
    );
    expect(res.status).toBe(500);
    expect(f.closed()).toBe(1); // no leaked DB connections on the error path
  });
});
