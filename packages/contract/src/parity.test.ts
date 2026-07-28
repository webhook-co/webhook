import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCapability, requiredSurfaces, SURFACES } from "./capability";
import { CAPABILITIES, triggersCreate } from "./capabilities";
import { assertCapabilityParity, emptyBindings, findParityViolations } from "./parity";

/**
 * Zod marks a strict object by setting its catchall to `never`. There is no public `.isStrict`, and
 * asserting on a parse result alone would let a schema that merely happens to have no extra keys in
 * the fixture pass — so read the marker directly.
 */
function isStrictObject(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _zod?: { def?: { type?: string; catchall?: unknown } } })._zod
    ?.def;
  if (def?.type !== "object") return false;
  const catchall = def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
  return catchall?._zod?.def?.type === "never";
}

/**
 * Unknown keys on a capability input must be REJECTED, not silently dropped.
 *
 * Zod's default is to strip. That made every surface — API, CLI, MCP, the SDKs — accept a field it
 * did not understand, discard it, and return 200. An agent that invented `eventTypes` on
 * `triggers.create` (a real field, but on the sibling `subscriptions.create`) got a success and a
 * trigger that did not do what it asked. Nothing anywhere said no.
 *
 * Strictness fixes it twice over: `safeParse` now returns `unrecognized_keys` → VALIDATION_ERROR on
 * every surface, and `z.toJSONSchema(input, { io: "input" })` starts emitting
 * `additionalProperties: false`, which is what the MCP tool schema advertises — so a model is told
 * the key is illegal BEFORE it calls, rather than being lied to afterwards.
 */
describe("capability inputs reject unknown keys", () => {
  it("has capabilities to check", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c] as const))("%s input is strict", (_name, cap) => {
    expect(isStrictObject(cap.input)).toBe(true);
  });

  it("rejects an invented key instead of silently dropping it", () => {
    const result = triggersCreate.input.safeParse({
      endpointId: "00000000-0000-4000-8000-000000000000",
      eventTypes: ["payment.succeeded"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("still accepts the same input without the invented key", () => {
    const result = triggersCreate.input.safeParse({
      endpointId: "00000000-0000-4000-8000-000000000000",
    });
    expect(result.success).toBe(true);
  });

  it("advertises additionalProperties:false to MCP clients", () => {
    const schema = z.toJSONSchema(triggersCreate.input, { io: "input" }) as {
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
  });
});

function fullBindings() {
  const b = emptyBindings();
  for (const surface of SURFACES) for (const cap of CAPABILITIES) b[surface].add(cap.name);
  return b;
}

/** Total (capability, required-surface) pairs once documented exemptions are honored. */
const requiredPairs = CAPABILITIES.reduce((n, c) => n + requiredSurfaces(c).length, 0);

describe("capability parity", () => {
  it("passes when every capability is bound on every GA surface", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, fullBindings())).not.toThrow();
  });

  it("flags a capability missing on a surface it is required on", () => {
    const b = fullBindings();
    // events.list is required on mcp (no exemption), so dropping it is a real violation.
    b.mcp.delete("events.list");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).toContainEqual({ capability: "events.list", surface: "mcp" });
  });

  it("does NOT flag a capability that is surfaceExempt on the missing surface", () => {
    const b = fullBindings();
    // events.replay is exempt on mcp (lands in slice 12), so dropping its mcp binding is fine.
    b.mcp.delete("events.replay");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).not.toContainEqual({ capability: "events.replay", surface: "mcp" });
  });

  it("reports exactly the required (capability, surface) pairs when nothing is bound", () => {
    const violations = findParityViolations(CAPABILITIES, emptyBindings());
    // Exemptions shrink the required set below CAPABILITIES.length * SURFACES.length.
    expect(violations).toHaveLength(requiredPairs);
    expect(requiredPairs).toBeLessThan(CAPABILITIES.length * SURFACES.length);
  });

  it("respects a documented surfaceExempt", () => {
    const internalOnly = defineCapability({
      name: "internal.only",
      input: z.object({}),
      output: z.object({}),
      errors: ["UNAUTHORIZED"],
      auth: { scope: "events:read" },
      semantics: {},
      surfaceExempt: { web: "no dashboard view planned", mcp: "not agent-relevant" },
    });
    const b = emptyBindings();
    b.api.add("internal.only");
    b.cli.add("internal.only");
    expect(() => assertCapabilityParity([internalOnly], b)).not.toThrow();
  });

  it("throws a readable error listing violations", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, emptyBindings())).toThrow(
      /parity violations/,
    );
  });
});

// The conformance gate: the capabilities actually bound on each surface TODAY must satisfy
// parity once the documented exemptions are honored. This encodes the live reality so that
// (a) shipping a GA surface without a required capability fails the build, and (b) an
// over-broad exemption — one that excuses a surface that IS in fact bound — is caught too.
// Slices 11/12 bind events.tail/replay on api+mcp and remove those exemptions, updating this
// map in lockstep; the frontend epic adds the web bindings and removes the WEB_DEFERRED ones.
describe("capability parity — current GA surfaces conformance", () => {
  // The real registered sets, mirrored here from each surface:
  //   cli  — packages/cli CAPABILITY_COMMANDS (every command: `listen`/`replay` map tail/replay)
  //   api  — apps/api router (the reads + endpoints.create/delete/rotate writes + events.tail cursor-pull)
  //   mcp  — apps/mcp McpAgent tools (the same set)
  //   web  — apps/web dashboard: endpoints.* management (events.* + audit still deferred to their slices)
  const API_MCP_BOUND = [
    "endpoints.list",
    "endpoints.get",
    "endpoints.create",
    "endpoints.delete",
    "endpoints.rotate",
    // endpoints.update (dedup config, ADR-0104): api + mcp (slice 3), cli (slice 3b), web (slice 4).
    "endpoints.update",
    // Ingest-URL reveal (S8-remainder / ADR-0101): the gated + audited programmatic capability, api+mcp+cli.
    // (The dashboard shows the URL via a separate DB-direct config read, so web is surfaceExempt — see below.)
    "endpoints.revealIngestUrl",
    // Provider-secret management (ADR-0078): full MCP parity (D2) — add/list/revoke on api+mcp+cli.
    "endpoints.addProviderSecret",
    "endpoints.listProviderSecrets",
    "endpoints.revokeProviderSecret",
    "events.list",
    "events.get",
    "events.tail",
    // events.delete (S3): the TOMBSTONE. api+mcp+cli+web parity — MCP-BOUND despite being destructive,
    // with mitigations (single-id, rate limit, audit row per delete, DESTRUCTIVE tool description).
    "events.delete",
    // Deliveries reads (S3 Slice 3 PR3): full api+mcp+cli parity (reading delivery status steers nothing —
    // unlike the subscriptions/destinations WRITE caps, which are mcp-exempt). Web-deferred.
    "deliveries.get",
    "deliveries.list",
    "audit.verify",
    // triggers.* (S5): webhook→agent trigger subscriptions. MCP-BOUND (unlike the egress subscriptions.*
    // above) — a trigger is a read-consumption registration, not egress, so an agent may manage its own.
    // create/list/revoke are ALSO web-bound (S5 dashboard slice — DB-direct server actions, see WEB_BOUND
    // below); only triggers.wait stays web-exempt (the dashboard streams live events over its own WebSocket).
    "triggers.create",
    "triggers.list",
    "triggers.revoke",
    // usage.get (S4.2): the metering usage surface — full api+mcp+cli+web parity (a read that steers
    // nothing; single-dimension events, no prices in the output).
    "usage.get",
    "triggers.wait",
  ];
  // The dashboard surface: endpoints.* (slice 2) + events.list/get (slice 3a) + events.getPayload (slice 3b —
  // the R2 payload viewer + download), all DB-direct server reads. events.tail / events.replay stay
  // web-deferred. audit.verify is now BOUND on web (Lane 2.8 — the /audit page's "Verify chain" button).
  const WEB_BOUND = [
    "audit.verify",
    "endpoints.list",
    "endpoints.get",
    "endpoints.create",
    "endpoints.delete",
    "endpoints.rotate",
    // endpoints.update (dedup config, ADR-0104): the dashboard's Deduplication section (slice 4) binds it
    // via a DB-direct server action (endpoint-actions.ts), so web is no longer exempt.
    "endpoints.update",
    // NOTE: endpoints.revealIngestUrl is NOT web-bound. The dashboard shows the ingest URL, but as endpoint
    // config via a DB-direct session read (endpoint-reveal.ts) — a lighter mechanism than this gated +
    // audited programmatic capability, which is why the capability is surfaceExempt on web (see capabilities.ts).
    "events.list",
    "events.get",
    "events.getPayload",
    // events.delete (S3): the dashboard's event delete — a DB-direct server action (event-actions.ts).
    "events.delete",
    // usage.get (S4.2): the dashboard usage view — a DB-direct server read (usage.ts), like events.list.
    "usage.get",
    // triggers.* (S5 web slice): the dashboard agent-triggers view (list + create + revoke) via DB-direct
    // server actions (agent-trigger-actions.ts). triggers.wait is NOT web-bound (see the note above).
    "triggers.create",
    "triggers.list",
    "triggers.revoke",
  ];
  function liveBindings() {
    const b = emptyBindings();
    for (const cap of CAPABILITIES) b.cli.add(cap.name); // CLI surfaces every command
    for (const name of API_MCP_BOUND) {
      b.api.add(name);
      b.mcp.add(name);
    }
    // events.getPayload is bound on api (+ cli, above) but exempt on mcp (no R2 binding) — slice 12a.
    b.api.add("events.getPayload");
    // events.replay is bound on api (+ cli, above) but exempt on mcp (localhost-tunnel is CLI-intrinsic) — PR3.
    b.api.add("events.replay");
    // replayDestinations.* (ADR-0081): bound on api (+ cli, above), web-deferred + mcp-exempt (an agent
    // must not mutate the SSRF-egress allowlist). api-only here, like events.replay.
    b.api.add("replayDestinations.create");
    b.api.add("replayDestinations.list");
    b.api.add("replayDestinations.delete");
    // Destination lifecycle (S3 Slice 3 PR3b): enable + setOrdered — same api-only + mcp-exempt posture.
    b.api.add("replayDestinations.enable");
    b.api.add("replayDestinations.setOrdered");
    // The destination signing-secret management (ADR-0084, S3 Slice 2): same surface posture (api + cli;
    // web-deferred; mcp-exempt — an agent must not mint/exfiltrate a signing secret).
    b.api.add("replayDestinations.rotateSigningSecret");
    b.api.add("replayDestinations.listSigningSecrets");
    // subscriptions.* (S3 Slice 3): bound on api (+ cli, above), web-deferred + mcp-exempt (an agent must
    // not reconfigure where an org's events are routed/delivered). api-only here, like replayDestinations.
    b.api.add("subscriptions.create");
    b.api.add("subscriptions.list");
    b.api.add("subscriptions.delete");
    // the dashboard surface (DB-direct server actions/reads): endpoints.* (slice 2) + events.list/get (slice 3a).
    for (const name of WEB_BOUND) b.web.add(name);
    return b;
  }

  it("passes parity with the documented exemptions", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, liveBindings())).not.toThrow();
  });

  it("would fail if a read capability were dropped from a required surface", () => {
    const b = liveBindings();
    b.api.delete("events.get");
    expect(() => assertCapabilityParity(CAPABILITIES, b)).toThrow(
      /events\.get is not bound on api/,
    );
  });

  it("keeps exemptions tight: endpoints.* + events.list/get/getPayload require web; tail/replay + audit web-deferred", () => {
    const tail = CAPABILITIES.find((c) => c.name === "events.tail");
    const replay = CAPABILITIES.find((c) => c.name === "events.replay");
    const getPayload = CAPABILITIES.find((c) => c.name === "events.getPayload");
    // events.tail bound on api+mcp as of slice 11 (cursor pull); replay bound on api as of PR3
    // (recording-server-side), mcp still exempt (localhost-tunnel is CLI-intrinsic).
    expect(requiredSurfaces(tail!)).toEqual(["api", "cli", "mcp"]);
    expect(requiredSurfaces(replay!)).toEqual(["api", "cli"]);
    // getPayload is bound on api + cli + web (slice 3b); mcp stays exempt (the McpAgent has no R2 binding).
    expect(requiredSurfaces(getPayload!)).toEqual(["api", "cli", "web"]);
    // The endpoints.* + events.list/get/getPayload capabilities are un-deferred on web; every other
    // capability — events.tail/replay + audit.verify — stays web-deferred until its slice.
    for (const cap of CAPABILITIES) {
      if (WEB_BOUND.includes(cap.name)) {
        expect(requiredSurfaces(cap), `${cap.name} must require web`).toContain("web");
      } else {
        expect(requiredSurfaces(cap), `${cap.name} must not require web yet`).not.toContain("web");
      }
    }
  });
});
