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
  it("builds ${apex}/<token> when the engine returns a token", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(async () => ({ found: true, token: "whep_live" }))),
    );
    expect(out).toBe("https://wbhk.my/whep_live");
  });

  it("returns null for an endpoint with no recoverable copy (rotate to reveal)", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(async () => ({ found: true, token: null }))),
    );
    expect(out).toBeNull();
  });

  it("returns null when the endpoint isn't found (deleted racing the metadata load)", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(async () => ({ found: false, token: null }))),
    );
    expect(out).toBeNull();
  });

  it("returns null (degrades) when the revealer binding is not provisioned", async () => {
    expect(await revealEndpointIngestUrl(input, deps(undefined))).toBeNull();
  });

  it("returns null (degrades) on a transient reveal fault — never blanks the endpoint page", async () => {
    const out = await revealEndpointIngestUrl(
      input,
      deps(revealerOf(() => Promise.reject(new Error("kms down")))),
    );
    expect(out).toBeNull();
  });
});
