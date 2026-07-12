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

type PollFn = (
  b: unknown,
  r: Cursor | undefined,
) => Promise<{ events: EventSummary[]; caughtUp: boolean }>;
type MetaFn = (
  o: string,
  e: string,
  r: Cursor | undefined,
) => Promise<{ headCursor: Cursor | null; backlogCount: number }>;

/** A fake auth handle: configurable principal / verify-throw / endpoint existence. No DB. */
function fakeAuth(opts: {
  ctx?: AuthContext;
  verifyThrows?: Error;
  exists?: boolean;
}): MakeListenAuth {
  return () =>
    Promise.resolve({
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
  since?: string;
  upgrade?: boolean;
  forgeOrgHeader?: string;
  forgeUserHeader?: string;
  origin?: string;
  subprotocol?: string;
}): Request {
  const url = new URL("https://engine.example/listen");
  if (opts.endpointId !== undefined) url.searchParams.set("endpointId", opts.endpointId);
  if (opts.sessionId) url.searchParams.set("sessionId", opts.sessionId);
  if (opts.sinceCursor !== undefined) url.searchParams.set("sinceCursor", opts.sinceCursor);
  if (opts.since !== undefined) url.searchParams.set("since", opts.since);
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.upgrade) headers.Upgrade = "websocket";
  if (opts.forgeOrgHeader) headers["x-listen-org-id"] = opts.forgeOrgHeader;
  if (opts.forgeUserHeader) headers["x-listen-user-id"] = opts.forgeUserHeader;
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.subprotocol) headers["sec-websocket-protocol"] = opts.subprotocol;
  return new Request(url, { headers });
}

const DASHBOARD_ORIGIN = "https://app.webhook.co";
const TICKET_ORG = "33333333-3333-3333-3333-333333333333";
const TICKET_ENDPOINT = "44444444-4444-4444-4444-444444444444";

/** A fake ticket verifier: returns a fixed grant, or null to simulate an invalid/expired ticket. */
function fakeVerifyTicket(grant: { orgId: string; endpointId: string; userId?: string } | null) {
  return async () => grant;
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
    // The /listen branch returns before any ingest deps are built, so this no-op ctx is never used.
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const res = await handleFetch(new Request("https://engine.example/listen"), bindings, ctx);
    expect(res.status).toBe(426);
  });

  it("upgrades to 101 and binds the DO to the bearer org, ignoring a forged header", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    // Pre-inject empty poll + backlog seams so neither the DO's inline flush nor the connect-time
    // status probe (ADR-0017) dials the absent Postgres.
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
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

  it("binds a grant-bound bearer's userId, and drops a forged x-listen-user-id", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        sessionId,
        upgrade: true,
        forgeUserHeader: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
      bindings,
      fakeAuth({ ctx: { orgId: ORG, scopes: ["events:read"], userId: "u-grant" }, exists: true }),
    );
    expect(res.status).toBe(101);

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ userId?: string }>("binding"),
    );
    expect(binding?.userId).toBe("u-grant"); // the bearer's verified user, not the forged header
  });

  it("omits userId for a standalone api key (no user on the auth context)", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        sessionId,
        upgrade: true,
        forgeUserHeader: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }), // READ_CTX has no userId
    );
    expect(res.status).toBe(101);

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ userId?: string }>("binding"),
    );
    // No user on the credential → no membership re-check subject; a forged header can't create one.
    expect(binding?.userId).toBeUndefined();
  });

  it("400s an invalid --since value before spinning a DO", async () => {
    const res = await handleListenUpgrade(
      listenReq({ auth: "Bearer whsk_ok", endpointId: crypto.randomUUID(), since: "garbage" }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }),
    );
    expect(res.status).toBe(400);
  });

  it("400s when --since and --sinceCursor are both present (mutually exclusive)", async () => {
    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        since: "2h",
        sinceCursor: "c",
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }),
    );
    expect(res.status).toBe(400);
  });
});

describe("listen upgrade — dashboard ticket", () => {
  const okAuth = fakeAuth({ ctx: READ_CTX, exists: true });

  it("401s a request with neither an Authorization header nor a ticket subprotocol", async () => {
    const res = await handleListenUpgrade(
      listenReq({ upgrade: true, origin: DASHBOARD_ORIGIN }),
      bindings,
      okAuth,
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }),
    );
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("403s a ticket presented from a disallowed Origin", async () => {
    const res = await handleListenUpgrade(
      listenReq({
        upgrade: true,
        origin: "https://evil.example",
        subprotocol: `wbhk.listen.v1, ticket.sometoken`,
      }),
      bindings,
      okAuth,
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }),
    );
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("401s an invalid/expired ticket (verifier returns null)", async () => {
    const res = await handleListenUpgrade(
      listenReq({
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        subprotocol: `wbhk.listen.v1, ticket.badtoken`,
      }),
      bindings,
      okAuth,
      fakeVerifyTicket(null),
    );
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("upgrades 101, binds the DO to the TICKET's org/endpoint, and echoes the subprotocol", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        sessionId,
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        // The query carries a DIFFERENT (attacker) endpoint; the ticket's endpoint must win.
        endpointId: "99999999-9999-9999-9999-999999999999",
        subprotocol: `wbhk.listen.v1, ticket.goodtoken`,
      }),
      bindings,
      okAuth,
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }),
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    // The browser aborts without the echo — the server must accept exactly the base subprotocol.
    expect(res.headers.get("sec-websocket-protocol")).toBe("wbhk.listen.v1");

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ orgId: string; endpointId: string }>("binding"),
    );
    // Bound to the SIGNED ticket, never the query string.
    expect(binding?.orgId).toBe(TICKET_ORG);
    expect(binding?.endpointId).toBe(TICKET_ENDPOINT);
  });

  // S.8 trusted-header boundary: the periodic membership re-check hinges on `x-listen-user-id` being set
  // from the VERIFIED credential and a client-supplied one being stripped. These tests exercise the upgrade
  // handler's own wiring (index.ts), which the DO-level tests can't — they inject the header directly.
  it("binds the DO to the TICKET's user and IGNORES a client-forged x-listen-user-id", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        sessionId,
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        subprotocol: "wbhk.listen.v1, ticket.goodtoken",
        forgeUserHeader: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // attacker-supplied; must be dropped
      }),
      bindings,
      okAuth,
      fakeVerifyTicket({
        orgId: TICKET_ORG,
        endpointId: TICKET_ENDPOINT,
        userId: "55555555-5555-5555-5555-555555555555",
      }),
    );
    expect(res.status).toBe(101);

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ userId?: string }>("binding"),
    );
    // The membership-check subject is the SIGNED ticket's user, never the forged header.
    expect(binding?.userId).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("omits userId (and drops a forged one) for an older USERLESS ticket", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        sessionId,
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        subprotocol: "wbhk.listen.v1, ticket.goodtoken",
        forgeUserHeader: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
      bindings,
      okAuth,
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }), // no userId (older mint)
    );
    expect(res.status).toBe(101);

    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ userId?: string }>("binding"),
    );
    // A userless ticket must NOT let a forged header smuggle in a membership subject.
    expect(binding?.userId).toBeUndefined();
  });

  it("prefers the bearer path when BOTH an Authorization header and a ticket subprotocol are present", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        checkStillMember: () => Promise<boolean>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.checkStillMember = async () => true; // no live Postgres in the pool; a userful binding would dial it
    });

    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        sessionId,
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        // A ticket for a DIFFERENT org rides alongside the bearer; the bearer must win + the ticket ignored.
        subprotocol: `wbhk.listen.v1, ticket.attacker`,
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }),
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }),
    );
    expect(res.status).toBe(101);
    // Bound to the BEARER org (READ_CTX = ORG), never the ticket's TICKET_ORG; no subprotocol echoed.
    expect(res.headers.get("sec-websocket-protocol")).toBeNull();
    const binding = await runInDurableObject(stub, (_i, state) =>
      state.storage.get<{ orgId: string }>("binding"),
    );
    expect(binding?.orgId).toBe(ORG);
  });

  it("404s when the ticket's endpoint no longer exists (defense in depth)", async () => {
    const res = await handleListenUpgrade(
      listenReq({
        upgrade: true,
        origin: DASHBOARD_ORIGIN,
        subprotocol: `wbhk.listen.v1, ticket.goodtoken`,
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: false }),
      fakeVerifyTicket({ orgId: TICKET_ORG, endpointId: TICKET_ENDPOINT }),
    );
    expect(res.status).toBe(404);
    expect(res.webSocket).toBeNull();
  });
});

describe("listen upgrade — since (bearer)", () => {
  it("forwards a valid --since grammar to the DO (resolved server-side), upgrading 101", async () => {
    const sessionId = crypto.randomUUID();
    const stub = bindings.LISTEN_SESSION.get(bindings.LISTEN_SESSION.idFromName(sessionId));
    const emptyPoll: PollFn = async () => ({ events: [], caughtUp: true });
    const emptyMeta: MetaFn = async () => ({ headCursor: null, backlogCount: 0 });
    const seen: { kind: string }[] = [];
    await runInDurableObject(stub, (inst) => {
      const di = inst as ListenSession & {
        pollEvents: PollFn;
        backlogMeta: MetaFn;
        resolveSinceCursor: (o: string, e: string, s: { kind: string }) => Promise<undefined>;
      };
      di.pollEvents = emptyPoll;
      di.backlogMeta = emptyMeta;
      di.resolveSinceCursor = async (_o, _e, s) => {
        seen.push(s);
        return undefined;
      };
    });

    const res = await handleListenUpgrade(
      listenReq({
        auth: "Bearer whsk_ok",
        endpointId: crypto.randomUUID(),
        sessionId,
        since: "2h",
        upgrade: true,
      }),
      bindings,
      fakeAuth({ ctx: READ_CTX, exists: true }),
    );
    expect(res.status).toBe(101);
    // The handler forwarded `x-listen-since-spec: 2h`; the DO re-parsed + resolved it server-side.
    expect(seen).toEqual([{ kind: "relative", ms: 7_200_000 }]);
  });
});
