import { env, runInDurableObject } from "cloudflare:test";
import { UnauthenticatedError, type AuthContext } from "@webhook-co/contract";
import type { Cursor, EventSummary } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { handleFetch, handleListenUpgrade, type Env, type MakeListenAuth } from "../src/index";
import type { ListenSession } from "../src/listen-session";

// The /listen upgrade gate, exercised with an injected auth seam (fake verifyBearer + endpoint guard)
// so the 401/403/404/400/426 decisions and header-binding are proven without a live Postgres. The
// success path forwards to the REAL DO, so we pre-inject its poll seam to keep PG out of the test.
const bindings = env as unknown as Env;

const ORG = "11111111-1111-1111-1111-111111111111";
const READ_CTX: AuthContext = { orgId: ORG, scopes: ["events:read"] };

type PollFn = (b: unknown, r: Cursor | undefined) => Promise<EventSummary[]>;

/** A fake auth handle: configurable principal / verify-throw / endpoint existence. No DB. */
function fakeAuth(opts: {
  ctx?: AuthContext;
  verifyThrows?: Error;
  exists?: boolean;
}): MakeListenAuth {
  return () => ({
    authDeps: {
      verifyBearer: async () => {
        if (opts.verifyThrows) throw opts.verifyThrows;
        return opts.ctx as AuthContext;
      },
      resource: "https://api.webhook.co",
      resourceMetadataUrl: "https://api.webhook.co/.well-known/oauth-protected-resource",
    },
    endpointExists: async () => opts.exists ?? true,
    close: async () => {},
  });
}

function listenReq(opts: {
  auth?: string;
  endpointId?: string;
  sessionId?: string;
  sinceCursor?: string;
  upgrade?: boolean;
  forgeOrgHeader?: string;
}): Request {
  const url = new URL("https://engine.example/listen");
  if (opts.endpointId !== undefined) url.searchParams.set("endpointId", opts.endpointId);
  if (opts.sessionId) url.searchParams.set("sessionId", opts.sessionId);
  if (opts.sinceCursor !== undefined) url.searchParams.set("sinceCursor", opts.sinceCursor);
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.upgrade) headers.Upgrade = "websocket";
  if (opts.forgeOrgHeader) headers["x-listen-org-id"] = opts.forgeOrgHeader;
  return new Request(url, { headers });
}

describe("listen upgrade — auth", () => {
  it("rejects a missing bearer with 401 + WWW-Authenticate and no socket", async () => {
    const res = await handleListenUpgrade(
      listenReq({ endpointId: crypto.randomUUID() }),
      bindings,
      fakeAuth({ ctx: READ_CTX }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.webSocket).toBeNull();
  });

  it("rejects an invalid/unknown token with 401", async () => {
    const res = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_bad", endpointId: crypto.randomUUID() }),
      bindings,
      fakeAuth({ verifyThrows: new UnauthenticatedError() }),
    );
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("rejects an under-scoped key with 403 (insufficient_scope)", async () => {
    const res = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_ok", endpointId: crypto.randomUUID() }),
      bindings,
      fakeAuth({ ctx: { orgId: ORG, scopes: ["endpoints:read"] } }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(res.webSocket).toBeNull();
  });
});

describe("listen upgrade — routing", () => {
  it("400s a missing or non-uuid endpointId", async () => {
    const missing = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_ok" }),
      bindings,
      fakeAuth({ ctx: READ_CTX }),
    );
    expect(missing.status).toBe(400);
    const bad = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_ok", endpointId: "not-a-uuid" }),
      bindings,
      fakeAuth({ ctx: READ_CTX }),
    );
    expect(bad.status).toBe(400);
  });

  it("404s an endpoint that doesn't exist for the org", async () => {
    const res = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_ok", endpointId: crypto.randomUUID() }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: false }),
    );
    expect(res.status).toBe(404);
    expect(res.webSocket).toBeNull();
  });

  it("426s a /listen request without a websocket upgrade (via the router)", async () => {
    const res = await handleFetch(new Request("https://engine.example/listen"), bindings);
    expect(res.status).toBe(426);
  });

  it("upgrades to 101 and binds the DO to the bearer org, ignoring a forged header", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    // Pre-inject an empty poll so the DO's inline backlog flush doesn't dial the absent Postgres.
    const emptyPoll: PollFn = async () => [];
    await runInDurableObject(stub, (inst) => {
      (inst as ListenSession & { pollEvents: PollFn }).pollEvents = emptyPoll;
    });

    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        sessionId,
        // A CR/LF-laden cursor must be dropped (not crash header-set into a 500); the upgrade still 101s.
        sinceCursor: "bad\r\ninjected",
        upgrade: true,
        forgeOrgHeader: "99999999-9999-9999-9999-999999999999", // attacker-supplied; must be ignored
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }),
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ orgId: string }>("binding"),
    );
    expect(binding?.orgId).toBe(ORG); // the verified principal's org, never the forged header
  });
});
