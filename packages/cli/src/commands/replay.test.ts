import { run } from "@stricli/core";
import { bytesToB64 } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";
const EP = "11111111-1111-4111-8111-111111111111";
const FORWARD = "http://localhost:3000/webhooks";
const BODY = new TextEncoder().encode('{"hello":"world"}');

function loggedInStore(): CredentialStore {
  return {
    get: async () => ({ apiKey: "whk_test" }),
    set: async () => undefined,
    erase: async () => undefined,
    list: async () => ["default"],
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => undefined,
  };
}
function noCredStore(): CredentialStore {
  return { ...loggedInStore(), get: async () => null };
}

const EVENT = {
  id: EVENT_ID,
  orgId: ORG,
  endpointId: EP,
  receivedAt: "2026-06-10T12:00:00.000Z",
  provider: "stripe",
  dedupKey: "dk_1",
  dedupStrategy: "content_hash",
  verified: true,
  payloadR2Key: "org/x/ep/y/z",
  payloadBytes: BODY.byteLength,
  contentType: "application/json",
  method: "POST",
  headers: [
    ["content-type", "application/json"],
    ["webhook-id", "msg_1"],
  ],
  providerEventId: "evt_1",
  externalId: null,
  verification: null,
};
const ENVELOPE = {
  contentType: "application/json",
  bytes: BODY.byteLength,
  bodyBase64: bytesToB64(BODY),
};
const ATT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTEMPT = {
  id: ATT_ID,
  orgId: ORG,
  eventId: EVENT_ID,
  target: '{"kind":"localhost-tunnel","sessionId":"s"}',
  idempotencyKey: "idem-1",
  status: "forwarded",
  statusCode: null,
  attempt: 1,
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
};

// A routing fake: serves the api reads/writes by path, and the localhost forward per `local`.
function fakeApi(opts: {
  local: { status: number } | "throw";
  onReplay?: (init: RequestInit) => void;
  onForward?: (init: RequestInit) => void;
  payload?: Uint8Array;
  attempt?: unknown;
}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.startsWith("http://localhost") || u.includes("127.0.0.1")) {
      opts.onForward?.(init ?? {});
      if (opts.local === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      return new Response("local-body", { status: opts.local.status });
    }
    if (method === "GET" && u.endsWith(`/v1/events/${EVENT_ID}`)) return Response.json(EVENT);
    if (method === "GET" && u.endsWith(`/v1/events/${EVENT_ID}/payload`)) {
      const p = opts.payload;
      return Response.json(
        p === undefined
          ? ENVELOPE
          : {
              contentType: "application/octet-stream",
              bytes: p.byteLength,
              bodyBase64: bytesToB64(p),
            },
      );
    }
    if (method === "POST" && u.endsWith(`/v1/events/${EVENT_ID}/replay`)) {
      opts.onReplay?.(init ?? {});
      return Response.json(opts.attempt ?? ATTEMPT);
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as unknown as typeof fetch;
}

describe("wbhk replay", () => {
  it("requires a credential", async () => {
    const t = makeTestContext({ store: noCredStore() });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });

  it("requires --forward (a usage error explaining replay is replay-to-localhost)", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["replay", EVENT_ID], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--forward");
  });

  it("rejects a non-loopback --forward target", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["replay", EVENT_ID, "--forward", "http://evil.example"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("localhost");
  });

  it("on a local 2xx: forwards exact bytes, records the attempt, exits 0", async () => {
    let replayInit: RequestInit | undefined;
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: fakeApi({ local: { status: 200 }, onReplay: (i) => (replayInit = i) }),
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout().toLowerCase()).toContain("delivered");
    expect(t.stdout()).toContain(ATT_ID);
    // recorded server-side with a localhost-tunnel target + an idempotency key
    const body = JSON.parse(String(replayInit?.body)) as {
      target: unknown;
      idempotencyKey: string;
    };
    expect(body.target).toMatchObject({ kind: "localhost-tunnel" });
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("on a local non-2xx: exits non-zero and does NOT record", async () => {
    let recorded = false;
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: fakeApi({ local: { status: 500 }, onReplay: () => (recorded = true) }),
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(t.stderr()).toContain("500");
    expect(recorded).toBe(false);
  });

  it("on a connection failure: exits TARGET_UNREACHABLE and does NOT record", async () => {
    let recorded = false;
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: fakeApi({ local: "throw", onReplay: () => (recorded = true) }),
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(
      CAPABILITY_EXIT.TARGET_UNREACHABLE,
    );
    expect(t.stderr().toLowerCase()).toContain("could not reach");
    expect(recorded).toBe(false);
  });
});

describe("wbhk replay --edit", () => {
  const decode = (b: unknown): string => new TextDecoder().decode(b as Uint8Array);

  it("forwards the EDITED body + warns the signature no longer matches", async () => {
    let forwarded: RequestInit | undefined;
    let editorSeen: { initial: string; editor: string } | undefined;
    const t = makeTestContext({
      store: loggedInStore(),
      env: { EDITOR: "vi" },
      fetch: fakeApi({ local: { status: 200 }, onForward: (i) => (forwarded = i) }),
      editText: async (initial, editor) => {
        editorSeen = { initial, editor };
        return '{"hello":"EDITED"}';
      },
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD, "--edit"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    // The editor saw the captured body + the resolved $EDITOR.
    expect(editorSeen).toEqual({ initial: '{"hello":"world"}', editor: "vi" });
    // The EDITED bytes were forwarded (not the original).
    expect(decode(forwarded?.body)).toBe('{"hello":"EDITED"}');
    // And the stale-signature caveat was surfaced.
    expect(t.stderr().toLowerCase()).toContain("signature no longer matches");
  });

  it("prefers $VISUAL and treats an editor-added trailing newline as unchanged (no warning, original bytes)", async () => {
    let forwarded: RequestInit | undefined;
    const t = makeTestContext({
      store: loggedInStore(),
      env: { VISUAL: "code --wait", EDITOR: "vi" },
      fetch: fakeApi({ local: { status: 200 }, onForward: (i) => (forwarded = i) }),
      // The common `:wq`: the editor appends a trailing newline to a newline-less body but the user
      // changed nothing — must forward the ORIGINAL bytes (no extra \n) and NOT warn.
      editText: async (initial) => initial + "\n",
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD, "--edit"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(decode(forwarded?.body)).toBe('{"hello":"world"}'); // original bytes, no trailing \n
    expect(t.stderr().toLowerCase()).not.toContain("signature no longer matches");
  });

  it("emits JSON on a delivered --edit replay", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: { EDITOR: "vi" },
      fetch: fakeApi({ local: { status: 200 } }),
      editText: async () => '{"hello":"EDITED"}',
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD, "--edit", "--output", "json"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(JSON.parse(t.stdout())).toMatchObject({ delivered: true, status: 200 });
  });

  it("errors (usage) when neither $VISUAL nor $EDITOR is set", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: {},
      fetch: fakeApi({ local: { status: 200 } }),
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD, "--edit"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr()).toContain("$EDITOR");
  });

  it("errors (usage) on a non-UTF-8 (binary) payload — can't open it as text", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: { EDITOR: "vi" },
      fetch: fakeApi({ local: { status: 200 }, payload: new Uint8Array([0xff, 0xfe, 0x00]) }),
    });
    await run(app, ["replay", EVENT_ID, "--forward", FORWARD, "--edit"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("text payload");
  });
});

describe("wbhk replay --destination (server-side remote delivery)", () => {
  const DEST = "55555555-5555-4555-8555-555555555555";
  const delivered = {
    ...ATTEMPT,
    target: '{"kind":"destination"}',
    status: "delivered",
    statusCode: 200,
  };
  const blocked = { ...ATTEMPT, status: "blocked", statusCode: null };

  it("delivers via the server (eventsReplay with a destination target) and exits 0", async () => {
    let replayInit: RequestInit | undefined;
    const t = makeTestContext({
      store: loggedInStore(),
      // local:"throw" proves the CLI NEVER touches localhost on the --destination path (the server delivers).
      fetch: fakeApi({ local: "throw", attempt: delivered, onReplay: (i) => (replayInit = i) }),
    });
    await run(app, ["replay", EVENT_ID, "--destination", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout().toLowerCase()).toContain("delivered");
    expect(t.stdout()).toContain("200");
    const body = JSON.parse(String(replayInit?.body)) as {
      target: { kind: string; destinationId: string };
    };
    expect(body.target).toEqual({ kind: "destination", destinationId: DEST });
  });

  it("a non-delivered outcome (blocked) exits non-zero", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: fakeApi({ local: "throw", attempt: blocked }),
    });
    await run(app, ["replay", EVENT_ID, "--destination", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.UNEXPECTED);
    expect(t.stdout().toLowerCase()).toContain("blocked");
  });

  it("rejects --destination together with --forward (usage)", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["replay", EVENT_ID, "--destination", DEST, "--forward", FORWARD], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("not both");
  });

  it("rejects --destination together with --edit (usage)", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["replay", EVENT_ID, "--destination", DEST, "--edit"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--edit");
  });
});
