import type { IngestUrlRevealerRpc, RevealedIngestToken } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { revealEndpointIngestUrl, type EndpointRevealDeps } from "./endpoint-reveal";

// The dashboard always-shown ingest-URL seam (S8-remainder slice 2b): calls the engine reveal RPC
// (identifier-only) and builds ${apex}/<token>, degrading to null (rotate-to-reveal hint) on no-copy /
// unprovisioned binding / transient fault — never crashing the endpoint-detail view. The unseal itself is
// engine-side (tested there); here we prove the web seam's mapping + fail-soft behavior.

const revealerOf = (impl: () => Promise<RevealedIngestToken>): IngestUrlRevealerRpc => ({
  revealIngestToken: impl,
});
const deps = (revealer: IngestUrlRevealerRpc | undefined): EndpointRevealDeps => ({
  revealer,
  apex: "https://wbhk.my",
});
const input = { orgId: "org-1", endpointId: "ep-1" };

describe("revealEndpointIngestUrl", () => {
  it("returns { url } = ${apex}/<token> when the engine returns a token", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(async () => ({ found: true, token: "whep_live" }))),
    );
    expect(out).toEqual({ kind: "url", url: "https://wbhk.my/whep_live" });
  });

  it("returns { no-copy } for an endpoint with no recoverable copy (rotate IS the fix)", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(async () => ({ found: true, token: null }))),
    );
    expect(out).toEqual({ kind: "no-copy" });
  });

  it("returns { unavailable } (NOT no-copy) when the revealer binding is not provisioned — the token exists, don't advise a rotate", async () => {
    expect(await revealEndpointIngestUrl(input, deps(undefined))).toEqual({ kind: "unavailable" });
  });

  it("retries ONCE and recovers when the first attempt throws (transient cold-path fault)", async () => {
    let calls = 0;
    const out = await revealEndpointIngestUrl(
      input,
      deps(
        revealerOf(async () => {
          calls += 1;
          if (calls === 1) throw new Error("Network connection lost");
          return { found: true, token: "whep_warm" };
        }),
      ),
    );
    expect(out).toEqual({ kind: "url", url: "https://wbhk.my/whep_warm" });
    expect(calls).toBe(2); // one retry
  });

  it("degrades to { unavailable } only after BOTH attempts throw — never blanks the endpoint page", async () => {
    let calls = 0;
    const out = await revealEndpointIngestUrl(
      input,
      deps(
        revealerOf(() => {
          calls += 1;
          return Promise.reject(new Error("kms down"));
        }),
      ),
    );
    expect(out).toEqual({ kind: "unavailable" });
    expect(calls).toBe(2); // retried once, then degraded
  });

  it("does NOT retry a no-copy result (found:true, token:null is terminal, not transient)", async () => {
    let calls = 0;
    const out = await revealEndpointIngestUrl(
      input,
      deps(
        revealerOf(async () => {
          calls += 1;
          return { found: true, token: null };
        }),
      ),
    );
    expect(out).toEqual({ kind: "no-copy" });
    expect(calls).toBe(1); // no retry for a terminal (non-throw) result
  });

  it("does NOT retry a TIMEOUT (a hang → single attempt → { unavailable }, no doubled RPC load)", async () => {
    let calls = 0;
    const out = await revealEndpointIngestUrl(input, {
      apex: "https://wbhk.my",
      timeoutMs: 20,
      revealer: revealerOf(() => {
        calls += 1;
        return new Promise(() => {}); // hangs → times out
      }),
    });
    expect(out).toEqual({ kind: "unavailable" });
    expect(calls).toBe(1); // a timeout is not retried
  });

  it("NEVER throws — a misconfigured apex degrades to { unavailable } instead of crashing the page", async () => {
    const out = await revealEndpointIngestUrl(input, {
      apex: "https://wbhk.my",
      // A revealer whose call itself throws synchronously is caught by the outer guard.
      revealer: {
        revealIngestToken: () => {
          throw new Error("boom");
        },
      },
    });
    expect(out).toEqual({ kind: "unavailable" });
  });
});
